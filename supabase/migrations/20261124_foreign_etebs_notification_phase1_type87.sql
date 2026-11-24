-- IPGate / 2026-11-24 / Yabancı müvekkil ETEBS bildirimi (AŞAMA 1) / type 87
-- Supabase SQL Editor'da TAMAMINI tek seferde çalıştırın.
-- Bu migrasyon mevcut e-posta bildirim statülerini DEĞİŞTİRMEZ.
-- AŞAMA 2'de decision_notification_pending ve gönderim kilidi ayrıca uygulanacaktır.
-- Gereksinimler: public.incoming_documents, tasks, task_documents, persons,
-- ip_records, ip_record_applicants, transactions, counters, users,
-- transaction_types, task_assignments.

BEGIN;

-- Görev tipi çakışması halinde başka tipin üzerine yazma: açık hata üret.
-- Aynı ID ve aynı ad zaten mevcutsa tekrar çalıştırılması güvenlidir.
DO $guard$
BEGIN
  -- Daha önce 9001 sürümü uygulanmışsa eski kayıtları sessizce bırakmayın.
  -- Eski görevlerin 87'ye güvenli taşınması ayrıca değerlendirilmelidir.
  IF EXISTS (
    SELECT 1 FROM public.transaction_types
    WHERE id = '9001' AND name = 'Karar / Tebligat Bildirim İşi'
  ) THEN
    RAISE EXCEPTION 'Önceki 9001 sürümü veritabanında bulundu. Çift görev tipi oluşturmamak için migrasyon durduruldu; mevcut 9001 görevleri kontrol edip 87''ye taşıma gerekir.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.transaction_types
    WHERE id = '87'
      AND name IS DISTINCT FROM 'Karar / Tebligat Bildirim İşi'
  ) THEN
    RAISE EXCEPTION 'Görev tipi 87 başka amaçla kullanılıyor. Migrasyon durduruldu.';
  END IF;
END;
$guard$;

-- Örnek verilen 66 numaralı işlem türüyle aynı genel/child şeması.
-- ID=87, üst düzey seçim yapılamaz; kendiliğinden başka görev tetiklemez.
INSERT INTO public.transaction_types (
  id, name, alias, ip_type, hierarchy, applicable_to_main_type,
  document_designation_default, order_index, is_top_level_selectable,
  allowed_child_types, index_file, index_bulk, index_manuel,
  task_triggered, due_period, due_period_unit, task_triggered_rules,
  suit_event_kind, suit_stage_scope, stage_transition_on_index,
  stage_transition_on_completion, suit_decision_config, suit_decision_task_rules
) VALUES (
  '87', 'Karar / Tebligat Bildirim İşi', 'Karar / Tebligat Bildirim İşi',
  'general', 'child', ARRAY['all']::text[],
  NULL, 0, false,
  ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
  NULL, 0, NULL, '[]'::jsonb,
  NULL, ARRAY[]::text[], NULL,
  NULL, '{}'::jsonb, '[]'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  alias = EXCLUDED.alias,
  ip_type = EXCLUDED.ip_type,
  hierarchy = EXCLUDED.hierarchy,
  applicable_to_main_type = EXCLUDED.applicable_to_main_type,
  document_designation_default = EXCLUDED.document_designation_default,
  order_index = EXCLUDED.order_index,
  is_top_level_selectable = EXCLUDED.is_top_level_selectable,
  allowed_child_types = EXCLUDED.allowed_child_types,
  index_file = EXCLUDED.index_file,
  index_bulk = EXCLUDED.index_bulk,
  index_manuel = EXCLUDED.index_manuel,
  task_triggered = EXCLUDED.task_triggered,
  due_period = EXCLUDED.due_period,
  due_period_unit = EXCLUDED.due_period_unit,
  task_triggered_rules = EXCLUDED.task_triggered_rules,
  suit_event_kind = EXCLUDED.suit_event_kind,
  suit_stage_scope = EXCLUDED.suit_stage_scope,
  stage_transition_on_index = EXCLUDED.stage_transition_on_index,
  stage_transition_on_completion = EXCLUDED.stage_transition_on_completion,
  suit_decision_config = EXCLUDED.suit_decision_config,
  suit_decision_task_rules = EXCLUDED.suit_decision_task_rules,
  updated_at = now();

-- Görev atama mekanizmasının mevcut portfolio_manager kuralını kullan.
-- Ayrıca trigger, kişilerde portföy sorumlusu yoksa indekslemeyi hatayla durdurur.
INSERT INTO public.task_assignments (id, assignment_type, assignee_ids, allow_manual_override)
VALUES ('87', 'portfolio_manager', ARRAY[]::text[], false)
ON CONFLICT (id) DO UPDATE SET
  assignment_type = EXCLUDED.assignment_type,
  allow_manual_override = EXCLUDED.allow_manual_override;

-- Mevcut sayısal görev ID'leriyle çakışmamak için global sayacı düzelt.
-- Tahakkukların T- ile başlayan ayrı sayacı etkilenmez.
INSERT INTO public.counters (id, last_id)
SELECT 'tasks', COALESCE(MAX(id::numeric), 0)
FROM public.tasks WHERE id ~ '^[0-9]+$'
ON CONFLICT (id) DO UPDATE
SET last_id = GREATEST(COALESCE(public.counters.last_id, 0), EXCLUDED.last_id);

-- Bir belge-müvekkil ikilisi için en fazla bir bildirim işi.
-- Önceki 9001 sürümü uygulanmışsa aynı isimli indeksin filtresi eski olabilir.
-- Bu özel indeksi doğru görev tipine göre yeniden oluşturmak güvenlidir.
DROP INDEX IF EXISTS public.uq_tasks_foreign_etebs_source_client;
CREATE UNIQUE INDEX uq_tasks_foreign_etebs_source_client
ON public.tasks ((details->>'source_document_id'), (details->>'client_id'))
WHERE task_type_id = '87';

CREATE OR REPLACE FUNCTION public.trg_create_foreign_etebs_notification_task()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_record public.ip_records%ROWTYPE;
    v_explicit_owner text;
    v_related_task_id text;
    v_parent_id text;
    v_parent_task_id text;
    v_client record;
    v_task_id text;
    v_counter numeric;
    v_created_by text;
    v_title text;
    v_label text;
    v_try integer;
BEGIN
    -- Yalnızca ETEBS evraklarının indekslenmesi. Manuel/dava/diğer akışlar izole.
    IF NEW.document_source IS DISTINCT FROM 'etebs' OR NEW.status IS DISTINCT FROM 'indexed' THEN
        RETURN NEW;
    END IF;

    -- Aynı indexed kaydın ilgisiz UPDATE'lerinde yeni sorgu/iş oluşturulmaz.
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'indexed'
           AND OLD.file_url IS NOT DISTINCT FROM NEW.file_url
           AND OLD.ip_record_id IS NOT DISTINCT FROM NEW.ip_record_id
           AND OLD.created_transaction_id IS NOT DISTINCT FROM NEW.created_transaction_id THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.ip_record_id IS NULL THEN
        RAISE EXCEPTION '[ETEBS BİLDİRİM] Dosya % için ip_record_id yok; indeksleme tamamlanmadı.', NEW.id;
    END IF;

    SELECT * INTO v_record FROM public.ip_records WHERE id = NEW.ip_record_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION '[ETEBS BİLDİRİM] Dosya % için portföy kaydı (%) bulunamadı.', NEW.id, NEW.ip_record_id;
    END IF;

    -- Müvekkil belirlerken öncelik: işlemin görevindeki task_owner_id.
    -- Üçüncü taraf marka sahibini asla doğrudan müvekkil kabul etme.
    IF NEW.created_transaction_id IS NOT NULL THEN
        SELECT t.task_id, t.parent_id INTO v_related_task_id, v_parent_id
        FROM public.transactions t WHERE t.id = NEW.created_transaction_id;

        IF v_parent_id IS NOT NULL THEN
            SELECT t.task_id INTO v_parent_task_id
            FROM public.transactions t WHERE t.id = v_parent_id;
        END IF;

        SELECT t.task_owner_id INTO v_explicit_owner
        FROM public.tasks t
        WHERE t.task_owner_id IS NOT NULL
          AND (
            t.id = v_related_task_id
            OR t.transaction_id = NEW.created_transaction_id
            OR t.id = v_parent_task_id
            OR t.transaction_id = v_parent_id
          )
        ORDER BY
          CASE
            WHEN t.id = v_related_task_id THEN 0
            WHEN t.transaction_id = NEW.created_transaction_id THEN 1
            WHEN t.id = v_parent_task_id THEN 2
            ELSE 3
          END,
          t.created_at DESC
        LIMIT 1;
    END IF;

    v_label := COALESCE(
      NULLIF((SELECT b.brand_name FROM public.ip_record_trademark_details b
              WHERE b.ip_record_id = NEW.ip_record_id), ''),
      NULLIF(v_record.application_number, ''),
      'Portföy kaydı'
    );
    v_title := LEFT('Karar / Tebligat Bildirim İşi - ' || v_label, 450);

    SELECT id INTO v_created_by FROM public.users
    WHERE id = NEW.user_id AND COALESCE(disabled, false) = false;

    -- Doğrudan görev sahibi varsa o kişinin yabancılık statüsünü esas al.
    -- Görev sahibi yoksa YALNIZ bize ait (self) portföy başvuru sahipleri
    -- değerlendirilir. Birden fazla yabancı müvekkil varsa ayrı ayrı iş açılır.
    FOR v_client IN
      SELECT p.id, p.name, p.portfolio_manager_user_id
      FROM public.persons p
      WHERE p.nationality_type = 'foreign'
        AND (
          (v_explicit_owner IS NOT NULL AND p.id = v_explicit_owner)
          OR (
            v_explicit_owner IS NULL
            AND v_record.record_owner_type = 'self'
            AND EXISTS (
              SELECT 1 FROM public.ip_record_applicants a
              WHERE a.ip_record_id = NEW.ip_record_id AND a.person_id = p.id
            )
          )
        )
      ORDER BY p.id
    LOOP
      -- Personel ayarı eksikse tebligatı sessizce indexed saymak yerine
      -- hata ver ve indeksleme işlemini geri al. Kullanıcı ilgili kişiyi düzeltir.
      IF v_client.portfolio_manager_user_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = v_client.portfolio_manager_user_id
            AND COALESCE(u.disabled, false) = false
      ) THEN
          RAISE EXCEPTION
            '[ETEBS BİLDİRİM] Yabancı müvekkil % (%) için etkin portföy sorumlusu yok. Kişi Yönetimi > Portföy Sorumlusu alanını tamamlayıp tekrar indeksleyin.',
            v_client.name, v_client.id;
      END IF;
      IF NULLIF(BTRIM(NEW.file_url), '') IS NULL THEN
          RAISE EXCEPTION
            '[ETEBS BİLDİRİM] Belge % için PDF bağlantısı yok. İndeksleme tamamlanmadı.', NEW.id;
      END IF;

      -- Eş zamanlı tekrarlanan isteklerde aynı belge-müvekkil eşleşmesini seri işle.
      PERFORM pg_advisory_xact_lock(hashtext(NEW.id), hashtext(v_client.id));

      SELECT t.id INTO v_task_id FROM public.tasks t
      WHERE t.task_type_id = '87'
        AND t.details->>'source_document_id' = NEW.id
        AND t.details->>'client_id' = v_client.id
      LIMIT 1;

      IF v_task_id IS NULL THEN
        FOR v_try IN 1..15 LOOP
          -- Ana görev sayacıyla uyumlu NUMERİK ID üretimi.
          INSERT INTO public.counters (id, last_id) VALUES ('tasks', 1)
          ON CONFLICT (id) DO UPDATE
              SET last_id = COALESCE(public.counters.last_id, 0) + 1
          RETURNING last_id INTO v_counter;

          INSERT INTO public.tasks (
            id, title, description, task_type_id, status, priority,
            ip_record_id, transaction_id, task_owner_id, assigned_to,
            created_by, details
          ) VALUES (
            (v_counter::bigint)::text,
            LEFT(v_title || ' | ' || COALESCE(v_client.name, v_client.id), 450),
            'ETEBS tebligatı indekslendi. Resmi PDF işin belgelerinde mevcuttur. '
              || 'Yabancı müvekkili Gmail üzerindeki mevcut e-posta zincirinden '
              || 'bilgilendirdikten sonra bu işi tamamlayınız.',
            '87', 'open', 'high',
            NEW.ip_record_id, NEW.created_transaction_id,
            v_client.id, v_client.portfolio_manager_user_id, v_created_by,
            jsonb_build_object(
              'source', 'etebs',
              'source_document_id', NEW.id,
              'client_id', v_client.id,
              'delivery_channel', 'gmail',
              'document_number', NEW.document_number,
              'document_type_id', NEW.transaction_type_id,
              'teblig_tarihi', NEW.teblig_tarihi,
              'foreign_client_notification', true
            )
          )
          ON CONFLICT DO NOTHING
          RETURNING id INTO v_task_id;

          IF v_task_id IS NOT NULL THEN EXIT; END IF;

          -- Başka bir indeksleme bu belge/müvekkil görevini oluşturmuş olabilir.
          SELECT t.id INTO v_task_id FROM public.tasks t
          WHERE t.task_type_id = '87'
            AND t.details->>'source_document_id' = NEW.id
            AND t.details->>'client_id' = v_client.id
          LIMIT 1;
          IF v_task_id IS NOT NULL THEN EXIT; END IF;
        END LOOP;

        IF v_task_id IS NULL THEN
           RAISE EXCEPTION '[ETEBS BİLDİRİM] Dosya % için benzersiz görev ID oluşturulamadı.', NEW.id;
        END IF;
      END IF;

      -- Kayıtlı ETEBS belgesini görevde açılır ve indirilebilir hale getir.
      -- Yeniden indekslemede belge kaydı kopyalanmaz; URL güncellenebilir.
      UPDATE public.task_documents
      SET document_name = COALESCE(NULLIF(NEW.file_name,''), 'ETEBS_Tebligati.pdf'),
          document_url = NEW.file_url
      WHERE task_id = v_task_id AND document_type = 'etebs_notification';

      IF NOT FOUND THEN
          INSERT INTO public.task_documents (
            task_id, document_name, document_url, document_type
          ) VALUES (
            v_task_id, COALESCE(NULLIF(NEW.file_name,''), 'ETEBS_Tebligati.pdf'),
            NEW.file_url, 'etebs_notification'
          );
      END IF;
    END LOOP;

    RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_foreign_etebs_notification_task ON public.incoming_documents;
CREATE TRIGGER trg_foreign_etebs_notification_task
AFTER INSERT OR UPDATE OF status, file_url, ip_record_id, created_transaction_id
ON public.incoming_documents
FOR EACH ROW
EXECUTE FUNCTION public.trg_create_foreign_etebs_notification_task();

COMMIT;

-- DİAGNOSTİK (salt-okunur): yeni işler ve ilişkili evraklar
-- SELECT t.id, t.title, t.status, t.task_owner_id, t.assigned_to,
--        t.details->>'source_document_id' AS source_document_id,
--        d.document_url
-- FROM public.tasks t
-- LEFT JOIN public.task_documents d ON d.task_id = t.id AND d.document_type = 'etebs_notification'
-- WHERE t.task_type_id = '87' ORDER BY t.created_at DESC LIMIT 50;

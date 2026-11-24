-- IPGate / Yabanci muvekkil ETEBS bildirimi / ASAMA 2
-- Gereksinim: 20261124_foreign_etebs_notification_phase1_type87.sql kurulmus olmali.
-- Kapsam: Yalniz document_index kaynakli, ETEBS evrakina bagli yabanci muvekkil bildirimleri.
-- Onemli: Mail otomatik gonderilmez. 87 tamamlaninca bekleme kalkar,
-- personel Gmail uzerinden bildirim yaptiktan sonra IPGate taslagini siler.
-- SQL Editor'da TAMAMINI BIR DEFA calistirin; tekrar calistirma guvenlidir.

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.transaction_types
    WHERE id = '87' AND name = 'Karar / Tebligat Bildirim İşi'
  ) OR to_regprocedure('public.trg_create_foreign_etebs_notification_task()') IS NULL THEN
    RAISE EXCEPTION 'ASAMA 1 (transaction_types.id=87 ve ETEBS is tetigi) bulunamadi. Once ASAMA 1 kurulmalidir.';
  END IF;
END;
$guard$;

-- Bir tebligatta birden fazla yabanci muvekkil varsa butun 87 isleri beklenir.
-- Eski associated_task_id alani 66 numarali degerlendirme isini gostermeye devam eder.
ALTER TABLE public.mail_notifications
  ADD COLUMN IF NOT EXISTS decision_notification_task_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE public.mail_notifications
  ADD COLUMN IF NOT EXISTS decision_notification_task_missing boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mail_notifications_foreign_etebs_source
  ON public.mail_notifications (source_document_id)
  WHERE source = 'document_index';

CREATE INDEX IF NOT EXISTS idx_mail_notifications_foreign_task_missing
  ON public.mail_notifications (id)
  WHERE source = 'document_index'
    AND decision_notification_task_missing = true
    AND deleted_at IS NULL;

-- Karar bildirimi kilidi veritabaninda kurulur: UI veya client tarafindan
-- status='pending' yazilmasi acik 87 isini/gorev eksikligini atlatamaz.
CREATE OR REPLACE FUNCTION public.guard_foreign_etebs_mail_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_doc_source text;
  v_foreign_client boolean := false;
  v_task_ids text[] := ARRAY[]::text[];
  v_unfinished_87 boolean := false;
  v_unfinished_66 boolean := false;
  v_missing_87 boolean := false;
BEGIN
  -- ETEBS bagini/status kilidini kaydin alanlarini degistirerek atlamak yasak.
  IF TG_OP = 'UPDATE' AND OLD.source = 'document_index'
     AND OLD.source_document_id IS NOT NULL
     AND EXISTS (
        SELECT 1 FROM public.incoming_documents d
        WHERE d.id = OLD.source_document_id AND d.document_source = 'etebs'
     ) THEN
    IF NEW.source IS DISTINCT FROM OLD.source
       OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
       OR NEW.associated_task_id IS DISTINCT FROM OLD.associated_task_id THEN
      RAISE EXCEPTION 'ETEBS mailinin kaynak evrak/gorev baglantisi degistirilemez.';
    END IF;
  END IF;

  IF NEW.source IS DISTINCT FROM 'document_index' OR NEW.source_document_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.document_source INTO v_doc_source
  FROM public.incoming_documents d WHERE d.id = NEW.source_document_id;
  IF v_doc_source IS DISTINCT FROM 'etebs' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(t.id ORDER BY t.id), ARRAY[]::text[])
    INTO v_task_ids
  FROM public.tasks t
  WHERE t.task_type_id = '87'
    AND t.details->>'source_document_id' = NEW.source_document_id;

  -- E-posta alicisi saptanamamis (client_id NULL) olsa bile yabanci
  -- portfoy sahibinin evragi serbest/gonderilebilir statude kalmasin.
  SELECT (
    EXISTS (
      SELECT 1 FROM public.persons p
      WHERE p.id = NEW.client_id AND p.nationality_type = 'foreign'
    )
    OR EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.persons p ON p.id = t.task_owner_id
      WHERE t.id = NEW.associated_task_id AND p.nationality_type = 'foreign'
    )
    OR EXISTS (
      SELECT 1 FROM public.incoming_documents d
      JOIN public.ip_records ir ON ir.id = d.ip_record_id
      JOIN public.ip_record_applicants a ON a.ip_record_id = ir.id
      JOIN public.persons p ON p.id = a.person_id
      WHERE d.id = NEW.source_document_id
        AND ir.record_owner_type = 'self'
        AND p.nationality_type = 'foreign'
    )
  ) INTO v_foreign_client;

  -- Birden fazla aliciya sahip maillerde client_id baska kisiyi gosterse dahi
  -- evraktaki en az bir 87 isi varsa maili guvenceye al.
  IF cardinality(v_task_ids) = 0
     AND NOT v_foreign_client
     AND cardinality(COALESCE(NEW.decision_notification_task_ids, ARRAY[]::text[])) = 0
     AND NOT COALESCE(NEW.decision_notification_task_missing, false) THEN
    RETURN NEW;
  END IF;

  -- Gonderilmis/iptal edilmis eski kayitlar geriye donuk degistirilmez.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('sent', 'cancelled') THEN
    RETURN NEW;
  END IF;

  v_missing_87 := cardinality(v_task_ids) = 0;
  SELECT EXISTS (
    SELECT 1 FROM public.tasks t
    WHERE t.id = ANY(v_task_ids)
      AND t.status IS DISTINCT FROM 'completed'
  ) INTO v_unfinished_87;

  -- Mailin eskiden bagli oldugu 66 isinin kilidi kaybolmaz.
  IF NEW.associated_task_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = NEW.associated_task_id
        AND t.task_type_id = '66'
        AND t.status IS DISTINCT FROM 'completed'
    ) INTO v_unfinished_66;
  END IF;

  NEW.decision_notification_task_ids := v_task_ids;
  NEW.decision_notification_task_missing := v_missing_87;

  IF NEW.status = 'cancelled' THEN
    -- Kullanici taslagi ancak Gmail bildirim isini kapattiktan sonra silebilir.
    IF v_missing_87 OR v_unfinished_87 THEN
      RAISE EXCEPTION 'Karar / Tebligat Bildirim Isi tamamlanmadan taslak silinemez.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'sent' THEN
    IF v_missing_87 OR v_unfinished_87 OR v_unfinished_66 THEN
      RAISE EXCEPTION 'Bagli karar bildirimi/degerlendirme isi tamamlanmadan mail gonderilmis sayilamaz.';
    END IF;
    RETURN NEW;
  END IF;

  IF v_missing_87 OR v_unfinished_87 THEN
    NEW.status := 'decision_notification_pending';
  ELSIF v_unfinished_66 THEN
    NEW.status := 'evaluation_pending';
  ELSIF COALESCE(array_length(NEW.to_list, 1), 0) = 0 THEN
    NEW.status := 'missing_info';
  ELSE
    NEW.status := 'pending';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_guard_foreign_etebs_mail_status ON public.mail_notifications;
CREATE TRIGGER trg_guard_foreign_etebs_mail_status
BEFORE INSERT OR UPDATE ON public.mail_notifications
FOR EACH ROW EXECUTE FUNCTION public.guard_foreign_etebs_mail_status();

-- Is tamamlaninca maili otomatik GONDERME; sadece statuyu yeniden hesapla.
-- 66 numarali degerlendirme isi aciksa decision kilidi kalksa dahi
-- evaluation_pending olarak devam eder.
CREATE OR REPLACE FUNCTION public.sync_foreign_etebs_mail_on_task_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NEW.task_type_id = '87' AND NEW.details->>'source_document_id' IS NOT NULL THEN
    UPDATE public.mail_notifications mn
       SET status = mn.status
     WHERE mn.source = 'document_index'
       AND mn.source_document_id = NEW.details->>'source_document_id'
       AND mn.status IS DISTINCT FROM 'sent'
       AND mn.status IS DISTINCT FROM 'cancelled';
  ELSIF NEW.task_type_id = '66' THEN
    UPDATE public.mail_notifications mn
       SET status = mn.status
     WHERE mn.source = 'document_index'
       AND mn.associated_task_id = NEW.id
       AND cardinality(mn.decision_notification_task_ids) > 0
       AND mn.status IS DISTINCT FROM 'sent'
       AND mn.status IS DISTINCT FROM 'cancelled';
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_foreign_etebs_mail_task_completed ON public.tasks;
CREATE TRIGGER trg_foreign_etebs_mail_task_completed
AFTER UPDATE OF status ON public.tasks
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.task_type_id IN ('66', '87'))
EXECUTE FUNCTION public.sync_foreign_etebs_mail_on_task_change();

DROP TRIGGER IF EXISTS trg_foreign_etebs_mail_task_created ON public.tasks;
CREATE TRIGGER trg_foreign_etebs_mail_task_created
AFTER INSERT ON public.tasks
FOR EACH ROW
WHEN (NEW.task_type_id = '87')
EXECUTE FUNCTION public.sync_foreign_etebs_mail_on_task_change();

-- ASAMA 1'de olusmus ama henuz gonderilmemis taslaklari da kilitle.
-- Gonderilen ve iptal edilen gecmis maillere dokunulmaz.
UPDATE public.mail_notifications mn
   SET status = mn.status
  FROM public.incoming_documents d
 WHERE mn.source = 'document_index'
   AND mn.source_document_id = d.id
   AND d.document_source = 'etebs'
   AND mn.deleted_at IS NULL
   AND mn.status IS DISTINCT FROM 'sent'
   AND mn.status IS DISTINCT FROM 'cancelled'
   AND (
     EXISTS (
       SELECT 1 FROM public.tasks t
       WHERE t.task_type_id = '87'
         AND t.details->>'source_document_id' = d.id
     )
     OR EXISTS (
       SELECT 1 FROM public.persons p
       WHERE p.id = mn.client_id AND p.nationality_type = 'foreign'
     )
   );

COMMIT;

-- Salt-okunur test: kilitli ve cozulmus taslaklar.
-- SELECT mn.id, mn.status, mn.source_document_id,
--        mn.associated_task_id, mn.decision_notification_task_ids,
--        mn.decision_notification_task_missing
-- FROM public.mail_notifications mn
-- WHERE mn.source = 'document_index'
--   AND (cardinality(mn.decision_notification_task_ids) > 0
--        OR mn.decision_notification_task_missing)
-- ORDER BY mn.created_at DESC LIMIT 50;

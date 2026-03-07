// supabase/functions/generate-similarity-report/index.ts

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import JSZip from "npm:jszip@3.10.1";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, PageBreak, ImageRun, BorderStyle } from "npm:docx@8.5.0";

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

const FONT_FAMILY = "Montserrat"; const GLOBAL_FONT_SIZE = 18; 
const COLORS = { CLIENT_HEADER: "1E40AF", SIMILAR_HEADER: "64748B", TEXT_DARK: "1E293B", NICE_BG: "F1F5F9", BORDER_LIGHT: "E2E8F0", DEADLINE_BG: "DBEAFE", DEADLINE_TEXT: "1E40AF", EXPERT_BG: "F8FAFC", EXPERT_BORDER: "1E40AF" };

async function downloadImageAsBuffer(imagePath: string, supabase: any): Promise<ArrayBuffer | null> {
    if (!imagePath) return null;
    try {
        if (imagePath.startsWith('data:image')) {
            const base64Data = imagePath.split(',')[1];
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }
            return bytes.buffer;
        }
        if (imagePath.startsWith('http')) { 
            const resp = await fetch(imagePath); 
            return resp.ok ? await resp.arrayBuffer() : null; 
        }
        const { data, error } = await supabase.storage.from('brand_images').download(imagePath);
        if (error) return null; 
        return await data.arrayBuffer();
    } catch (e) { return null; }
}

async function createComparisonPage(group: any, supabase: any) {
    const similarMark = group.similarMark || {}; const monitoredMarks = group.monitoredMarks || []; const monitoredMark = monitoredMarks.length > 0 ? monitoredMarks[0] : {};
    const elements = []; const tableRows = [];

    // 🔥 DÜZELTME: Ön yüzden hesaplanıp gelen hatasız tarihi kullanıyoruz!
    const docObjectionDeadline = similarMark.calculatedDeadline || "-";

    let monitoredImageBuffer = await downloadImageAsBuffer(monitoredMark.imagePath || monitoredMark.brandImageUrl, supabase);
    let similarImageBuffer = await downloadImageAsBuffer(similarMark.imagePath || similarMark.brandImageUrl, supabase);

    tableRows.push(new TableRow({ height: { value: 400, rule: "atLeast" }, children: [ new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, children: [ new Paragraph({ children: [new TextRun({ text: "MÜVEKKİL MARKASI", bold: true, size: GLOBAL_FONT_SIZE, color: "FFFFFF", font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { before: 100, after: 50 } }), new Paragraph({ children: [new TextRun({ text: "(İZLENEN)", size: 14, color: "FFFFFF", italics: true, font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }) ], shading: { fill: COLORS.CLIENT_HEADER }, verticalAlign: "center", borders: { right: { style: BorderStyle.SINGLE, size: 6, color: "FFFFFF" } } }), new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, children: [ new Paragraph({ children: [new TextRun({ text: "BENZER MARKA", bold: true, size: GLOBAL_FONT_SIZE, color: "FFFFFF", font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { before: 100, after: 50 } }), new Paragraph({ children: [new TextRun({ text: "(BÜLTEN)", size: 14, color: "FFFFFF", italics: true, font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }) ], shading: { fill: COLORS.SIMILAR_HEADER }, verticalAlign: "center" }) ] }));

    const createVisualCell = (imageBuffer: ArrayBuffer | null) => { const content = []; if (imageBuffer) { try { content.push(new Paragraph({ children: [new ImageRun({ data: imageBuffer, transformation: { width: 160, height: 160 } })], alignment: AlignmentType.CENTER, spacing: { before: 150, after: 150 } })); } catch (e) {} } else { content.push(new Paragraph({ children: [new TextRun({ text: "(Görsel Yok)", size: GLOBAL_FONT_SIZE, color: "94A3B8", italics: true, font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } })); } return new TableCell({ children: content, verticalAlign: "center", shading: { fill: "FFFFFF" }, borders: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.BORDER_LIGHT } } }); };
    tableRows.push(new TableRow({ children: [createVisualCell(monitoredImageBuffer), createVisualCell(similarImageBuffer)] }));

    const createInfoRow = (label: string, val1: string, val2: string, bgColor = "FFFFFF") => { return new TableRow({ children: [ new TableCell({ children: [ new Paragraph({ children: [new TextRun({ text: label, bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.SIMILAR_HEADER, font: FONT_FAMILY })], spacing: { before: 80, after: 40 } }), new Paragraph({ children: [new TextRun({ text: val1 || "-", size: GLOBAL_FONT_SIZE, color: COLORS.TEXT_DARK, font: FONT_FAMILY })], spacing: { after: 80 } }) ], shading: { fill: bgColor }, margins: { left: 120 }, verticalAlign: "center", borders: { right: { style: BorderStyle.SINGLE, size: 2, color: COLORS.BORDER_LIGHT } } }), new TableCell({ children: [ new Paragraph({ children: [new TextRun({ text: label, bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.SIMILAR_HEADER, font: FONT_FAMILY })], spacing: { before: 80, after: 40 } }), new Paragraph({ children: [new TextRun({ text: val2 || "-", size: GLOBAL_FONT_SIZE, color: COLORS.TEXT_DARK, font: FONT_FAMILY })], spacing: { after: 80 } }) ], shading: { fill: bgColor }, margins: { left: 120 }, verticalAlign: "center" }) ] }); };
    
    // 🔥 DÜZELTME: Sınıf numaraları gelmese de kodun çökmesini engelleyen güvenli format
    const formatNiceClasses = (classes: any) => { 
        if (!classes || classes.length === 0) return "-"; 
        const classArray = Array.isArray(classes) ? classes : String(classes).split(/[,\s]+/).filter(Boolean); 
        if (classArray.length === 0) return "-";
        return classArray.map((c:string) => `[${c}]`).join(" "); 
    };
    
    tableRows.push(createInfoRow("Nice Sınıfları", formatNiceClasses(monitoredMark.niceClasses), formatNiceClasses(similarMark.niceClasses), COLORS.NICE_BG));
    tableRows.push(createInfoRow("Başvuru No", monitoredMark.applicationNo, similarMark.applicationNo));
    tableRows.push(createInfoRow("Başvuru Tarihi", monitoredMark.applicationDate, similarMark.applicationDate, "FAFAFA"));
    tableRows.push(createInfoRow("Sahip", monitoredMark.ownerName, similarMark.ownerName));

    const successChance = similarMark.bs || "";
    tableRows.push(new TableRow({ height: { value: 600, rule: "atLeast" }, children: [ new TableCell({ children: [ new Paragraph({ children: [new TextRun({ text: "İTİRAZ İÇİN SON TARİH", size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 } }), new Paragraph({ children: [new TextRun({ text: docObjectionDeadline, bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { after: 120 } }) ], shading: { fill: COLORS.DEADLINE_BG }, verticalAlign: "center", borders: { top: { style: BorderStyle.SINGLE, size: 8, color: COLORS.CLIENT_HEADER }, right: { style: BorderStyle.SINGLE, size: 4, color: "FFFFFF" } } }), new TableCell({ children: [ new Paragraph({ children: [new TextRun({ text: "İTİRAZ BAŞARI ŞANSI", size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 } }), new Paragraph({ children: [ new TextRun({ text: successChance ? (successChance.includes('%') ? successChance : `%${successChance}`) : "-", bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY }) ], alignment: AlignmentType.CENTER, spacing: { after: 120 } }) ], shading: { fill: COLORS.DEADLINE_BG }, verticalAlign: "center", borders: { top: { style: BorderStyle.SINGLE, size: 8, color: COLORS.SIMILAR_HEADER } } }) ] }));

    const comparisonTable = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.SIMILAR_HEADER }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.SIMILAR_HEADER }, left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.SIMILAR_HEADER }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.SIMILAR_HEADER }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: COLORS.BORDER_LIGHT }, insideVertical: { style: BorderStyle.SINGLE, size: 2, color: COLORS.BORDER_LIGHT } }, rows: tableRows });
    elements.push(comparisonTable);

    if (similarMark.note && String(similarMark.note).trim() !== "") {
        elements.push(new Paragraph({ text: "", spacing: { after: 150 } }));
        let logoBuffer = await downloadImageAsBuffer('https://ip-manager-production-aab4b.web.app/evreka-logo.png', supabase);
        const noteTable = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [ new TableRow({ children: [ new TableCell({ children: [ ...(logoBuffer ? [new Paragraph({ children: [new ImageRun({ data: logoBuffer, transformation: { width: 100, height: 50 } })], alignment: AlignmentType.CENTER, spacing: { before: 100, after: 80 } })] : []), new Paragraph({ children: [new TextRun({ text: "UZMAN DEĞERLENDİRMESİ", bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.EXPERT_BORDER, font: FONT_FAMILY })], alignment: AlignmentType.CENTER, spacing: { before: logoBuffer ? 0 : 120, after: 120 } }) ], shading: { fill: "FFFFFF" }, verticalAlign: "center", borders: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.EXPERT_BORDER } } }) ] }), new TableRow({ children: [ new TableCell({ children: [ new Paragraph({ children: [new TextRun({ text: String(similarMark.note).trim(), size: GLOBAL_FONT_SIZE, color: COLORS.TEXT_DARK, font: FONT_FAMILY })], alignment: AlignmentType.LEFT, spacing: { before: 100, after: 100 } }) ], shading: { fill: COLORS.EXPERT_BG }, margins: { left: 150, right: 150, top: 100, bottom: 100 }, verticalAlign: "center" }) ] }) ], borders: { top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.EXPERT_BORDER }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.EXPERT_BORDER }, left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.EXPERT_BORDER }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.EXPERT_BORDER } } });
        elements.push(noteTable);
    }
    elements.push(new Paragraph({ text: "", spacing: { after: 400 } })); return elements;
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);
        const { results, bulletinNo } = await req.json();

        if (!results || !Array.isArray(results)) throw new Error("Geçersiz veri formatı");

        const owners: Record<string, any[]> = {};
        results.forEach((m) => {
            const ownerName = m.monitoredMark?.ownerName || "Bilinmeyen_Sahip";
            if (!owners[ownerName]) owners[ownerName] = [];
            owners[ownerName].push(m);
        });

        const zip = new JSZip();

        for (const [ownerNameKey, matches] of Object.entries(owners)) {
            const grouped: Record<string, any> = {};
            matches.forEach((m) => {
                const key = m.similarMark?.applicationNo || 'unknown';
                if (!grouped[key]) grouped[key] = { similarMark: m.similarMark, monitoredMarks: [] };
                grouped[key].monitoredMarks.push(m.monitoredMark);
            });

            const reportContent: any[] = [];
            let i = 0;
            for (const group of Object.values(grouped)) {
                if (i > 0) reportContent.push(new Paragraph({ children: [new PageBreak()] }));
                const pageElements = await createComparisonPage(group, supabase);
                reportContent.push(...pageElements);
                i++;
            }

            const doc = new Document({ sections: [{ children: reportContent }] });
            const docBuffer = await Packer.toBuffer(doc);
            
            const safeDocName = ownerNameKey.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 25);
            const fileName = `${safeDocName}_Rapor.docx`;
            zip.file(fileName, docBuffer);

            // 🔥 DÜZELTME: Mail taslağındaki son tarih de hatasız veriden alınacak
            const mailObjectionDeadline = matches[0]?.similarMark?.calculatedDeadline || "-";
            const targetClientId = matches[0]?.monitoredMark?.clientId || matches[0]?.monitoredMark?.details?.clientId || null;

            if (targetClientId && bulletinNo) {
                const storagePath = `bulletin_reports/${bulletinNo}/${targetClientId}/${fileName}`;
                
                await supabase.storage.from('brand_images').upload(storagePath, docBuffer, { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', upsert: true });
                const { data: pUrlData } = supabase.storage.from('brand_images').getPublicUrl(storagePath);

                const { error: mailError } = await supabase.from('mail_notifications').insert({
                    record_id: targetClientId, 
                    subject: `${bulletinNo} Sayılı Bülten İzleme Raporu`,
                    body: `<p>Sayın İlgili,</p><p>${bulletinNo} sayılı bülten marka izleme raporunuz ekte sunulmuştur.</p>`,
                    status: 'awaiting_client_approval',
                    created_at: new Date().toISOString(),
                    details: {
                        client_id: targetClientId, 
                        applicant_name: ownerNameKey, 
                        bulletin_no: String(bulletinNo), 
                        objection_deadline: mailObjectionDeadline,
                        is_draft: true, 
                        notification_type: 'marka', 
                        source: 'bulletin_watch_system', 
                        attachments: [{ fileName, storagePath, url: pUrlData.publicUrl }] 
                    }
                });
            }
        }

        const zipBase64 = await zip.generateAsync({ type: "base64" });
        return new Response(JSON.stringify({ success: true, file: zipBase64 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});

    } catch (error) {
        console.error("❌ Rapor Hatası:", error);
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }
});
// functions/index.js
import admin from 'firebase-admin';
import path from 'path';
import os from 'os';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { createExtractorFromFile } from 'node-unrar-js';
import nodemailer from 'nodemailer';
import stream from 'stream';
import { pipeline } from 'stream/promises';
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated, onDocumentUpdated, onDocumentWritten, onDocumentDeleted} from 'firebase-functions/v2/firestore';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import logger from 'firebase-functions/logger';
import cors from 'cors';
import fetch from 'node-fetch';
import { PubSub } from '@google-cloud/pubsub';
import archiver from 'archiver';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
         WidthType, AlignmentType, HeadingLevel, PageBreak } from 'docx';
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { google } from "googleapis";
import { auth } from 'firebase-functions/v1';
import { getAuth } from 'firebase-admin/auth';                          // Admin SDK (modüler)
import { getFirestore, FieldValue } from 'firebase-admin/firestore';    // Admin SDK (modüler)
import { addMonthsToDate, findNextWorkingDay, isHoliday, isWeekend, TURKEY_HOLIDAYS } from './utils.js';
import { ImageRun } from 'docx';
import { v4 as uuidv4 } from "uuid";
import { PDFDocument } from 'pdf-lib';
import readline from 'readline';

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

const adminAuth = admin.auth();
const adminDb = admin.firestore();
const db        = adminDb;
const secretClient = new SecretManagerServiceClient();
const selcanUserId = "788e10fb-f137-4a78-b03d-840b14a14b87"; // <<< BURAYA SELCAN'IN GERÇEK ID'SİNİ YAPIŞTIRIN
const selcanUserEmail = "selcanakoglu@evrekapatent.com"; // <<< BURAYA SELCAN'IN E-POSTA ADRESİNİ YAZIN

// 🔐 SA_MAILER_KEY'i Secret Manager'dan çek
async function loadMailerSA() {
  const name = `projects/${process.env.GCLOUD_PROJECT}/secrets/SA_MAILER_KEY/versions/latest`;
  const [ver] = await secretClient.accessSecretVersion({ name });
  return JSON.parse(ver.payload.data.toString("utf8")); // { client_email, private_key, ... }
}

// ✅ Göndermeye yetkili kişiler
const ALLOWED_SENDERS = new Set([
  "alikucuksahin@evrekagroup.com",
  "bekirguven@evrekagroup.com",
  "kubilayguzel@evrekagroup.com",
  "kubilayguzel@evrekapatent.com",
  "erhankocabacak@evrekagroup.com",
  "selcanakoglu@evrekagroup.com",
  "hukuk@evrekagroup.com",
  "beyzasevinc@evrekagroup.com",
  "yigitdemirtas@evrekagroup.com",
  "rumeysatimurlenk@evrekagroup.com"
]);

// 📧 Gmail API ile Stream (Akış) Tabanlı Gönderim - RAM Dostu Versiyon
async function sendViaGmailAsUser(userEmail, mailOptions, threadId = null, inReplyTo = null, references = null, customMessageId = null) {
  const sa = await loadMailerSA();

  // Headerları Hazırla
  const headers = mailOptions.headers || {};
  if (customMessageId) headers['Message-ID'] = customMessageId;
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers['References'] = references;
  
  mailOptions.headers = headers;

  // 1. Nodemailer Stream Transport (Buffer: FALSE olmalı)
  const streamTransport = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: false // <--- ÖNEMLİ: Bufferlama yapma, stream üret
  });

  // 2. Maili Derle (Bu işlem artık bellek tüketmez, bir akış döndürür)
  const compiled = await streamTransport.sendMail({
    ...mailOptions,
    from: `"${mailOptions.fromName || "IPGate-EVREKA GROUP"}" <${userEmail}>`,
    sender: undefined,
    replyTo: mailOptions.replyTo || userEmail
  });

  // 3. Gmail API İsteği (Media Upload Yöntemi)
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    subject: userEmail
  });

  const gmail = google.gmail({ version: "v1", auth });
  
  // RAW string yerine MEDIA (Stream) gönderimi yapıyoruz
  // Bu sayede Base64 dönüşümü parça parça yapılarak gönderilir.
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: threadId || undefined // Metadata (Thread ID vb.) buraya
    },
    media: {
      mimeType: 'message/rfc822',
      body: compiled.message // <--- Nodemailer'ın ürettiği Stream doğrudan buraya bağlanır
    }
  });

  return res.data; 
}

// Firebase Admin SDK'sını başlatın
if (!admin.apps.length) {
  admin.initializeApp();
}
const pubsubClient = new PubSub(); // pubsubClient'ı burada tanımlayın

// ********************************************************************************
async function ensureTopic(name) {
  try {
    const [exists] = await pubsubClient.topic(name).exists();
    if (!exists) {
      await pubsubClient.createTopic(name);
      console.log(`🆕 Pub/Sub topic created: ${name}`);
    }
  } catch (err) {
    console.error(`⚠️ ensureTopic error for ${name}:`, err.message || err);
    throw err;
  }
}

// CORS ayarları
const corsOptions = {
    origin: [
        'https://kubilayguzel.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5173',
        'https://ip-manager-production-aab4b.web.app', // Bu satırı ekleyin
        'https://ipgate-31bd2.web.app',               // Yeni canlı ortamı da ekleyin
        'https://ipgate.evrekagroup.com'              // Özel domaininizi de ekleyin
    ],
    credentials: true,
    optionsSuccessStatus: 200
};
const corsHandler = cors(corsOptions);

// SMTP transporter configuration
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "kubilayguzel@evrekapatent.com",
    pass: "rqvl tpbm vkmu lmxi"
  }
});

// =========================================================
//              HTTPS FONKSİYONLARI (v2)
// =========================================================

// ETEBS Hata Kodları (Teknik Doküman'dan alınmıştır)
const ETEBS_ERROR_CODES = {
    '001': 'Eksik Parametre',
    '002': 'Hatalı Token',
    '003': 'Sistem Hatası',
    '004': 'Hatalı Evrak Numarası',
    '005': 'Daha Önce İndirilmiş Evrak (Sistemden indirme hakkı kalmamış olabilir)',
    '006': 'Evraka Ait Ek Bulunamadı'
};

// --- BASE64 ÇIKARMA YARDIMCILARI ---
function joinNumericKeyObject(obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return null;

  const allNumeric = keys.every(k => String(Number(k)) === k);
  if (!allNumeric) return null;

  return keys
    .sort((a, b) => Number(a) - Number(b))
    .map(k => obj[k])
    .join('');
}

// --- YENİ HELPER: Tüm parçaları liste olarak döner ---
function extractAllAttachments(downloadRawData) {
  // Dokümana göre ana düğüm: DownloadDocumentResult
  let node = downloadRawData?.DownloadDocumentResult ?? downloadRawData;
  const documents = [];

  // Yardımcı: Tek bir objeden Base64 çıkarma
  const extractFromObject = (obj) => {
    if (!obj) return null;
    if (typeof obj === 'string') return obj; // Direkt string ise
    
    // 1. Standart BASE64 alanı
    if (obj.BASE64 && typeof obj.BASE64 === 'string') return obj.BASE64;
    
    // 2. Parçalanmış numeric keys (0, 1, 2...) kontrolü
    const joined = joinNumericKeyObject(obj);
    if (joined) return joined;

    return null;
  };

  // Eğer dizi ise (Dizi = Üst Yazı + Ekler)
  if (Array.isArray(node)) {
    node.forEach(item => {
      const b64 = extractFromObject(item);
      const desc = item.BELGE_ACIKLAMASI || item.belgeAciklamasi || "Ek";
      if (b64) documents.push({ base64: b64, description: desc });
    });
  } 
  // Eğer tek obje ise
  else if (typeof node === 'object') {
    const b64 = extractFromObject(node);
    const desc = node.BELGE_ACIKLAMASI || node.belgeAciklamasi || "Ana Doküman";
    if (b64) documents.push({ base64: b64, description: desc });
  }

  return documents;
}

// ETEBS API Proxy Function (Toptan Kayıt Modeli)
// functions/index.js (GÜNCELLENMİŞ ETEBS PROXY)

export const etebsProxyV2 = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 540,
    memory: '2GiB' // Yüksek bellek şart
  },
  async (req, res) => {
    return corsHandler(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }

      try {
        const { action, token, userId } = req.body;

        if (!action || !token || !userId) {
          return res.status(400).json({ success: false, error: 'Eksik parametreler.' });
        }

        // --- 1. LİSTELEME ---
        const listApiUrl = 'https://epats.turkpatent.gov.tr/service/TP/DAILY_NOTIFICATIONS?apikey=etebs';
        const listResponse = await fetch(listApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ TOKEN: token })
        });
        
        if (!listResponse.ok) throw new Error(`Liste API Hatası: ${listResponse.status}`);
        const listResult = await listResponse.json();
        
        if (listResult?.IslemSonucKod && listResult.IslemSonucKod !== '000') {
           return res.status(400).json({ success: false, error: listResult.IslemSonucAck, code: listResult.IslemSonucKod });
        }

        // Listeyi normalize et
        let notifications = [];
        if (Array.isArray(listResult)) notifications = listResult;
        else if (listResult.DAILY_NOTIFICATIONSResult) notifications = listResult.DAILY_NOTIFICATIONSResult;
        else if (listResult.notifications) notifications = listResult.notifications;

        // --- 🔥 DÜZELTME: LİSTE TEKİLLEŞTİRME (DEDUPLICATION) ---
        // API bazen aynı evrakı çift döndürebiliyor, bu da gereksiz işlem ve log kirliliği yaratıyor.
        const uniqueMap = new Map();
        notifications.forEach(item => {
            const docNo = String(item.EVRAK_NO || item.evrakNo || '').trim();
            if (docNo && !uniqueMap.has(docNo)) {
                uniqueMap.set(docNo, item);
            }
        });
        notifications = Array.from(uniqueMap.values());

        console.log(`📊 ${notifications.length} tebligat bulundu.`);

        const savedDocuments = [];
        const downloadFailures = [];
        
        // --- 2. İNDİRME DÖNGÜSÜ ---
        const CHUNK_SIZE = 5; 
        for (let i = 0; i < notifications.length; i += CHUNK_SIZE) {
            const chunk = notifications.slice(i, i + CHUNK_SIZE);
            console.log(`📦 İşleniyor: ${i + 1}-${Math.min(i + CHUNK_SIZE, notifications.length)}`);
            
            await Promise.all(chunk.map(async (notification) => {
                const docNo = String(notification.EVRAK_NO || notification.evrakNo || '').trim();
                const belgeAciklamasi = notification.BELGE_ACIKLAMASI || notification.belgeAciklamasi || 'Belge';

                if (!docNo) return;

                try {
                    // Mükerrer Kontrolü
                    const existingQuery = await adminDb.collection('unindexed_pdfs').where('evrakNo', '==', docNo).limit(1).get();
                    if (!existingQuery.empty) {
                        const doc = existingQuery.docs[0].data();
                        if (doc.fileUrl && doc.status !== 'error') {
                            savedDocuments.push({ ...doc, id: existingQuery.docs[0].id, isPreExisting: true });
                            return;
                        }
                    }

                    // --- İNDİRME İSTEĞİ ---
                    const downloadApiUrl = 'https://epats.turkpatent.gov.tr/service/TP/DOWNLOAD_DOCUMENT?apikey=etebs';
                    
                    // Parametre: DOCUMENT_NO (Alt çizgili - Doğru)
                    const requestBody = { 
                        "TOKEN": token, 
                        "DOCUMENT_NO": docNo 
                    };
                    
                    const downloadResponse = await fetch(downloadApiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestBody),
                        timeout: 90000 // 90sn timeout
                    });

                    // İçerik tipi JSON değilse .json() denemek yerine text al
                    const ct = (downloadResponse.headers.get('content-type') || '').toLowerCase();

                    let downloadRawData;
                    if (ct.includes('application/json') || ct.includes('text/json') || ct.includes('application/problem+json')) {
                      downloadRawData = await downloadResponse.json();
                    } else {
                      const txt = await downloadResponse.text();
                      // JSON gibi görünüyorsa parse etmeyi dene
                      try {
                        downloadRawData = JSON.parse(txt);
                      } catch {
                        // JSON değilse burada kontrollü şekilde "BASE64 yok" sayacağız
                        downloadRawData = { __rawText: txt, IslemSonucKod: 'NON_JSON', IslemSonucAck: 'Non-JSON response' };
                      }
                    }

                    // --- 🔥 DÜZELTME: ÇOKLU DOSYA BİRLEŞTİRME VE KAYDETME ---
                    
                    // 1) Standart Hata Kontrolü
                    if (downloadRawData?.IslemSonucKod && downloadRawData.IslemSonucKod !== '000') {
                      if (downloadRawData.IslemSonucKod === '005') {
                        downloadFailures.push({ docNo, reason: 'SKIP: 005 (daha önce indirildi)' });
                        return;
                      }
                      throw new Error(`API Hatası: ${downloadRawData.IslemSonucAck} (${downloadRawData.IslemSonucKod})`);
                    }

                    // 2) Tüm parçaları (Üst yazı + Ekler) liste olarak al
                    const documentParts = extractAllAttachments(downloadRawData);

                    if (!documentParts || documentParts.length === 0) {
                        console.error(`❌ [${docNo}] BASE64 verisi bulunamadı.`);
                        downloadFailures.push({ docNo, reason: 'BASE64 verisi okunamadı.' });
                        return;
                    }

                    let finalPdfBuffer;

                    try {
                        // A) Birden fazla parça varsa BİRLEŞTİR (MERGE)
                        if (documentParts.length > 1) {
                            console.log(`🧩 [${docNo}] ${documentParts.length} parça birleştiriliyor...`);
                            
                            const mergedPdf = await PDFDocument.create();

                            for (const part of documentParts) {
                                if (!part.base64) continue;
                                // Base64 -> Buffer
                                const partBuffer = Buffer.from(part.base64, 'base64');
                                // PDF Load
                                const partDoc = await PDFDocument.load(partBuffer);
                                // Sayfaları Kopyala
                                const copiedPages = await mergedPdf.copyPages(partDoc, partDoc.getPageIndices());
                                // Yeni PDF'e Ekle
                                copiedPages.forEach((page) => mergedPdf.addPage(page));
                            }

                            // Birleşmiş PDF'i oluştur
                            const mergedBytes = await mergedPdf.save();
                            finalPdfBuffer = Buffer.from(mergedBytes);
                        } 
                        // B) Tek parça ise direkt al
                        else {
                            finalPdfBuffer = Buffer.from(documentParts[0].base64, 'base64');
                        }

                    } catch (mergeError) {
                        console.error(`❌ [${docNo}] PDF Birleştirme Hatası:`, mergeError);
                        downloadFailures.push({ docNo, reason: 'PDF birleştirme hatası: ' + mergeError.message });
                        return;
                    }

                    // --- KAYDETME ---
                    const fileName = `${docNo}_document.pdf`;
                    const storagePath = `etebs_documents/${userId}/${docNo}/${fileName}`;
                    const bucket = admin.storage().bucket();
                    const file = bucket.file(storagePath);

                    const downloadToken = uuidv4();

                    await file.save(finalPdfBuffer, { 
                        contentType: 'application/pdf',
                        metadata: { 
                            metadata: { 
                                originalName: belgeAciklamasi,
                                firebaseStorageDownloadTokens: downloadToken,
                                mergedCount: documentParts.length // Kaç dosya birleşti bilgisi
                            } 
                        }
                    });

                    // URL oluşturma (Mevcut kodunuzun devamı buradan sonra aynen kalabilir)
                    const encodedPath = encodeURIComponent(storagePath);
                    const firebaseUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
                    
                    // Döküman ID'si olarak doğrudan evrak numarasını kullanıyoruz
                    const targetRef = adminDb.collection('unindexed_pdfs').doc(docNo);

                    const docData = {
                        evrakNo: docNo,
                        belgeAciklamasi,
                        dosyaNo: notification.DOSYA_NO ? String(notification.DOSYA_NO).trim() : (notification.dosyaNo ? String(notification.dosyaNo).trim() : null),
                        dosyaTuru: notification.DOSYA_TURU || notification.dosyaTuru || null,
                        uygulamaKonmaTarihi: notification.UYGULAMAYA_KONMA_TARIHI || notification.uygulamayaKonmaTarihi || null,
                        belgeTarihi: notification.BELGE_TARIHI || notification.belgeTarihi || null,
                        ilgiliVekil: notification.ILGILI_VEKIL || notification.ilgiliVekil || null,
                        tebligTarihi: notification.TEBLIG_TARIHI || notification.tebligTarihi || null,
                        tebellugeden: notification.TEBELLUGEDEN || notification.tebellugeden || null,

                        // DÜZELTİLEN SATIR:
                        fileUrl: firebaseUrl, // Yukarıda oluşturduğunuz token'lı güvenli URL'yi buraya veriyoruz
                        
                        filePath: storagePath,
                        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                        userId,
                        status: 'pending',
                        unindexedPdfId: docNo,
                        downloadSuccess: true,
                        matched: false
                    };

                    await targetRef.set(docData, { merge: true });
                    savedDocuments.push(docData);
                    console.log(`✅ Kaydedildi: ${docNo} (URL: ${downloadUrl})`);


                } catch (err) {
                    console.error(`💥 Hata (${docNo}):`, err.message);
                    downloadFailures.push({ docNo, reason: err.message });
                }
            }));
        }

        res.json({
          success: true,
          data: {
            message: `İşlem tamamlandı. ${savedDocuments.length} başarılı, ${downloadFailures.length} hatalı.`,
            savedDocuments,
            failures: downloadFailures
          }
        });

      } catch (error) {
        console.error("Kritik Hata:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }
);

// Health Check Function (v2 sözdizimi)
export const etebsProxyHealthV2 = onRequest(
    {
        region: 'europe-west1'
    },
    (req, res) => {
        return corsHandler(req, res, () => {
            res.json({
                status: 'healthy',
                service: 'ETEBS Proxy',
                timestamp: new Date().toISOString(),
                version: '1.0.0'
            });
        });
    }
);

// ETEBS Token Validation Function (v2 sözdizimi)
export const validateEtebsTokenV2 = onRequest(
    {
        region: 'europe-west1'
    },
    (req, res) => {
        return corsHandler(req, res, () => {
            if (req.method !== 'POST') {
                return res.status(405).json({ error: 'Method not allowed' });
            }

            const { token } = req.body;

            if (!token) {
                return res.status(400).json({
                    valid: false,
                    error: 'Token required'
                });
            }

            const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

            if (!guidRegex.test(token)) {
                return res.status(400).json({
                    valid: false,
                    error: 'Invalid token format'
                });
            }

            res.json({
                valid: true,
                format: 'GUID',
                timestamp: new Date().toISOString()
            });
        });
    }
);

// Storage'taki PDF dosyasını bulup Nodemailer'a eklenti (attachment) olarak vermek.
async function buildNotificationAttachments(db, notificationData) {
  const result = { attachments: [], footerItems: [] };
  const MAX_BYTES = 20 * 1024 * 1024; // 20MB
  const bucket = admin.storage().bucket();

  const safeName = (name, def = "document.pdf") =>
    String(name || def).replace(/[^\w.\-]+/g, "_").slice(0, 100);

  const pathFromURL = (url) => {
    try {
      const m = new URL(url).pathname.match(/\/o\/(.+?)(?:\?|$)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  };

  const addAsAttachmentOrLink = async ({ storagePath, downloadURL, fileName }) => {
    const name = safeName(fileName);
    if (!storagePath) {
      // path yoksa linke düş
      if (downloadURL) {
        result.footerItems.push(
          `<a href="${downloadURL}" target="_blank" rel="noopener">${name}</a>`
        );
      } else {
        result.footerItems.push(name);
      }
      return true;
    }
    try {
      const [meta] = await bucket.file(storagePath).getMetadata();
      const size = Number(meta.size || 0);
      if (size > MAX_BYTES) {
        if (downloadURL) {
          result.footerItems.push(
            `<a href="${downloadURL}" target="_blank" rel="noopener">${name}</a>`
          );
        } else {
          result.footerItems.push(name);
        }
        return true;
      }
      
      // buildNotificationAttachments fonksiyonu içinde addAsAttachmentOrLink kısmını bul:
      if (storagePath) {
            // ESKİ KOD (SİLİNECEK):
            // const [buf] = await bucket.file(storagePath).download();
            
            // YENİ KOD (EKLENECEK - Stream Mantığı):
            const readStream = bucket.file(storagePath).createReadStream();

            // MIME Type Belirleme (Aynı kalıyor)
            let contentType = "application/pdf";
            const lowerName = name.toLowerCase();
            
            if (lowerName.endsWith(".zip")) {
              contentType = "application/zip";
            } else if (lowerName.endsWith(".docx")) {
              contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            }

            result.attachments.push({
              filename: name,
              content: readStream, // <-- ARTIK BUFFER DEĞİL, STREAM GÖNDERİYORUZ
              contentType: contentType,
            });
        }

      return true;
    } catch (e) {
      // storage erişilemezse son çare link
      if (downloadURL) {
        result.footerItems.push(
          `<a href="${downloadURL}" target="_blank" rel="noopener">${name}</a>`
        );
        return true;
      }
      return false;
    }
  };

  try {
    console.log("🔍 [ATTACH] builder start", {
      associatedTaskId: notificationData?.associatedTaskId,
      sourceDocumentId: notificationData?.sourceDocumentId,
    });

    // 1) Task → EPATS (TaskComplete akışı)
    const taskId = notificationData?.associatedTaskId;
    if (taskId) {
      try {
        const t = await adminDb.collection("tasks").doc(taskId).get();
        const ep = t.exists ? (t.data()?.details?.epatsDocument || null) : null;
        if (ep) {
          let storagePath = ep.storagePath || pathFromURL(ep.downloadURL || ep.fileUrl);
          await addAsAttachmentOrLink({
            storagePath,
            downloadURL: ep.downloadURL || ep.fileUrl || null,
            fileName: ep.name || "epats.pdf",
          });
        }
      } catch (e) {
        console.warn("⚠️ [ATTACH] task/EPATS okunamadı:", e?.message || e);
      }
    }

    // 2) unindexed_pdfs (DocumentStatusChange akışı)
    const docId = notificationData?.sourceDocumentId;
    if (docId) {
      try {
        const u = await adminDb.collection("unindexed_pdfs").doc(docId).get();
        if (u.exists) {
          const d = u.data() || {};
          let storagePath = d.filePath || pathFromURL(d.fileUrl || d.downloadURL);
          await addAsAttachmentOrLink({
            storagePath,
            downloadURL: d.fileUrl || d.downloadURL || null,
            fileName: d.fileName || "document.pdf",
          });
        }
      } catch (e) {
        console.warn("⚠️ [ATTACH] unindexed_pdfs okunamadı:", e?.message || e);
      }
    }

    // 3) Supplementary Attachment (YENİ - İtiraz Dilekçesi vb.)
    if (notificationData?.supplementaryAttachment) {
        const sa = notificationData.supplementaryAttachment;
        let storagePath = sa.storagePath || pathFromURL(sa.downloadURL || sa.fileUrl);
        await addAsAttachmentOrLink({
            storagePath,
            downloadURL: sa.downloadURL || sa.fileUrl,
            fileName: sa.fileName || "ek_dosya.pdf"
        });
    }

    // [YENİ EKLENEN KISIM] 4) Task Üzerindeki Diğer Belgeler (documents dizisi)
    if (notificationData?.taskAttachments && Array.isArray(notificationData.taskAttachments)) {
        console.log(`📎 [ATTACH] Ekstra ${notificationData.taskAttachments.length} belge ekleniyor...`);
        for (const doc of notificationData.taskAttachments) {
            let storagePath = doc.storagePath || pathFromURL(doc.url || doc.downloadURL);
            await addAsAttachmentOrLink({
                storagePath,
                downloadURL: doc.url || doc.downloadURL,
                fileName: doc.name || "belge.pdf"
            });
        }
    }

    return result;
  } catch (err) {
    console.error("❌ [ATTACH] Genel hata:", err);
    return result;
  }
}

export const createObjectionTask = onCall(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '256MiB'
  },
  async (request) => {
    const { monitoredMarkId, similarMark, similarMarkName, bulletinNo, callerEmail, bulletinRecordData } = request.data;    
    if (!monitoredMarkId || !similarMark || !bulletinNo) {
      throw new HttpsError('invalid-argument', 'Eksik parametre: monitoredMarkId, similarMark veya bulletinNo gereklidir.');
    }

    logger.log(`🚀 İtiraz İşi Oluşturuluyor: Hit=${similarMarkName || similarMark?.markName}, MonitoredId=${monitoredMarkId}`);

    try {
      // 1) İzlenen marka
      const monitoredDoc = await adminDb.collection('monitoringTrademarks').doc(monitoredMarkId).get();
      if (!monitoredDoc.exists) throw new HttpsError('not-found', 'İzlenen marka bulunamadı: ' + monitoredMarkId);

      const monitoredData = monitoredDoc.data();
      // YENİ: relatedRecordId alanı da kontrol ediliyor
      const relatedIpRecordId = monitoredData.ipRecordId || monitoredData.sourceRecordId || monitoredData.relatedRecordId || null;
      if (!relatedIpRecordId) throw new HttpsError('not-found', 'İzlenen marka için ilişkili IP kaydı bulunamadı.');

      // 2) Client bilgisi
      let clientId = monitoredData.clientId || null;
      let clientEmail = null;

      // 🔥 YENİ: Denormalize alanlar için değişkenler
      let ipAppNo = "-";
      let ipTitle = monitoredData.title || "-";
      let ipAppName = "-";

      if (relatedIpRecordId) {
        const ipDoc = await adminDb.collection('ipRecords').doc(relatedIpRecordId).get();
        if (ipDoc.exists) {
          const ipData = ipDoc.data();
          clientId = clientId || ipData.clientId || (ipData.applicants?.[0]?.id);
          
          ipAppNo = ipData.applicationNumber || ipData.applicationNo || "-";
          ipTitle = ipData.title || ipData.markName || ipTitle;
          if (Array.isArray(ipData.applicants) && ipData.applicants.length > 0) {
             ipAppName = ipData.applicants[0].name || "-";
          } else if (ipData.client && ipData.client.name) {
             ipAppName = ipData.client.name;
          }
        }
      }

      if (clientId) {
        const personDoc = await adminDb.collection('persons').doc(clientId).get();
        if (personDoc.exists) clientEmail = personDoc.data()?.email || null;
      }

      // 3) Atama
      const assignee = await resolveApprovalAssignee(adminDb, '20');
      const assignedTo_uid = assignee?.uid || null;
      const assignedTo_email = assignee?.email || callerEmail || null;

      // 4) Bülten tarihini al (DD/MM/YYYY) → Date
      let bulletinDate = null;
      let bulletinDateStr = null;
      try {
        const q = await adminDb.collection('trademarkBulletins')
          .where('bulletinNo', '==', bulletinNo)
          .limit(1)
          .get();
        if (!q.empty) {
          const b = q.docs[0].data();
          bulletinDateStr = b.bulletinDate || null; // "12/08/2025"
          if (bulletinDateStr && typeof bulletinDateStr === 'string') {
            const [dd, mm, yyyy] = bulletinDateStr.split('/');
            bulletinDate = new Date(parseInt(yyyy,10), parseInt(mm,10)-1, parseInt(dd,10));
            bulletinDate.setHours(0,0,0,0);
          }
        }
      } catch (e) {
        logger.warn('⚠️ Bülten tarihi alınamadı:', e);
      }

      // 5) Due Date hesapları (resmî tatil/hafta sonu kaydırmalı)
      let officialDueDate = null;
      let dueDateDetails = null;
      if (bulletinDate) {
        // +2 ay
        const rawDue = addMonthsToDate(bulletinDate, 2);
        // İlk iş günü (hafta sonu + TR tatilleri)
        const adjustedOfficial = findNextWorkingDay(rawDue, TURKEY_HOLIDAYS, { isWeekend, isHoliday });

        officialDueDate = adjustedOfficial;

        dueDateDetails = {
          bulletinDate: bulletinDate.toISOString().split('T')[0],
          periodMonths: 2,
          originalCalculatedDate: rawDue.toISOString().split('T')[0],
          finalOfficialDueDate: adjustedOfficial.toISOString().split('T')[0],
          finalOperationalDueDate: adjustedOfficial.toISOString().split('T')[0], // şimdilik aynı
          adjustments: []
        };

        logger.log('✅ dueDate hesaplandı:', dueDateDetails);
      } else {
        logger.warn('⚠️ Bülten tarihi bulunamadı; dueDate boş kalacak.');
      }

      // 6) Task ID (counter)
      const countersRef = adminDb.collection('counters').doc('tasks');
      const taskId = await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(countersRef);
        const last = snap.exists ? Number(snap.data()?.lastId || 0) : 0;
        const next = last + 1;
        tx.set(countersRef, { lastId: next, value: admin.firestore.FieldValue.delete() }, { merge: true });
        return String(next);
      });

      // 7) Task verisi
      const hitMarkName = similarMarkName || similarMark?.markName || 'Bilinmeyen Marka';
      const taskTitle = `Yayına İtiraz: ${hitMarkName} (Bülten No: ${bulletinNo})`;
      const taskDescription = `${monitoredData.title || 'İzlenen marka'} için bültende benzer bulunan ${hitMarkName} markasına itiraz işi.`;

      const taskData = {
        id: taskId,
        taskType: '20',
        status: 'awaiting_client_approval',
        priority: 'medium',
        relatedIpRecordId,
        relatedIpRecordTitle: monitoredData.title || hitMarkName,
        clientId,
        clientEmail,

        assignedTo_uid,
        assignedTo_email,

        title: taskTitle,
        description: taskDescription,
        iprecordApplicationNo: ipAppNo,
        iprecordTitle: ipTitle,
        iprecordApplicantName: ipAppName,

        details: {
          objectionTarget: hitMarkName,
          targetAppNo: similarMark?.applicationNo || '',
          targetNiceClasses: similarMark?.niceClasses || [],
          bulletinNo,
          bulletinDate: bulletinDateStr || null,
          monitoredMarkId: monitoredMarkId,
          similarityScore: similarMark?.similarityScore || 0,
          relatedParty: {
            id: clientId || null,
            name: null // Aşağıda doldurulacak
          }
        },

        // 👇 dueDate şimdilik officialDueDate ile aynı
        dueDate:         officialDueDate ? admin.firestore.Timestamp.fromDate(officialDueDate) : null,
        officialDueDate: officialDueDate ? admin.firestore.Timestamp.fromDate(officialDueDate) : null,
        officialDueDateDetails: dueDateDetails || null,

        source: 'similarity_search',
        createdBy: callerEmail || 'system',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),

        history: [{
                  timestamp: new Date().toISOString(),
                  action: 'Benzerlik aramasından otomatik iş oluşturuldu',
                  userEmail: callerEmail || 'system'
                }]
              };

              // ✅ İtiraz sahibinin adını al ve task data'ya ekle
              if (clientId) {
                try {
                  const personDoc = await adminDb.collection('persons').doc(clientId).get();
                  if (personDoc.exists) {
                    const personData = personDoc.data();
                    const realName = personData.name || personData.companyName || 'İzlenen Marka Sahibi';
                    
                    taskData.details.relatedParty.name = realName;
                    taskData.details.relatedParty.email = personData.email || null;
                    taskData.details.relatedParty.phone = personData.phone || null;
                    
                    // YENİ EKLENEN SATIR: Listelerde görünmesi için ana alanı güncelliyoruz
                    taskData.iprecordApplicantName = realName; 
                  }
                } catch (e) {
                  logger.warn('⚠️ İtiraz sahibi bilgisi details\'e eklenemedi:', e);
                  taskData.details.relatedParty.name = 'İzlenen Marka Sahibi';
                  // YENİ EKLENEN SATIR (Hata durumu için fallback)
                  taskData.iprecordApplicantName = 'İzlenen Marka Sahibi';
                }
              }

      // 8) Kaydet
      await adminDb.collection('tasks').doc(taskId).set(taskData);
      logger.log(`✅ Yayına İtiraz İşi Oluşturuldu. Task ID: ${taskId}`);

      // ✅ Bulletin kaydını oluştur (eğer bulletinRecordData sağlandıysa)
      let createdBulletinRecordId = null;
      if (bulletinRecordData) {
        try {
          const bulletinRecordRef = await adminDb.collection('trademarkBulletinRecords').add({
            ...bulletinRecordData,
            createdAt: FieldValue.serverTimestamp(),
            createdBy: callerEmail || 'system',
            source: 'similarity_search'
          });
          createdBulletinRecordId = bulletinRecordRef.id;
          logger.log(`✅ Bulletin kaydı oluşturuldu: ${createdBulletinRecordId}`);
        } catch (bulletinErr) {
          logger.error('❌ Bulletin kaydı oluşturma hatası:', bulletinErr);
        }
      }

      // ✅ Üçüncü taraf portföy kaydına (3rd party ipRecord) transaction ekle
      try {
        // İtiraz sahibini belirle (müvekkil)
        let oppositionOwnerName = null;
        if (clientId) {
          try {
            const personDoc = await adminDb.collection('persons').doc(clientId).get();
            if (personDoc.exists) {
              oppositionOwnerName = personDoc.data()?.name || null;
            }
          } catch (e) {
            logger.warn('⚠️ İtiraz sahibi adı alınamadı:', e);
          }
        }

        // ✅ DEĞİŞİKLİK: Transaction, 3rd party portföy kaydına eklenmeli
        // thirdPartyIpRecordId, portfolioByOppositionCreator tarafından oluşturulan kayıt ID'si
        if (!thirdPartyIpRecordId) {
          logger.warn('⚠️ thirdPartyIpRecordId bulunamadı, transaction eklenemedi');
        } else {
          const transactionsRef = adminDb
            .collection('ipRecords')
            .doc(thirdPartyIpRecordId)
            .collection('transactions');
          
          await transactionsRef.add({
            type: '20',
            designation: 'Yayına İtiraz',
            description: 'Yayına İtiraz',
            transactionHierarchy: 'parent',
            taskId: String(taskId),
            ...(oppositionOwnerName ? { oppositionOwner: oppositionOwnerName } : {}),
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            userId: 'cloud_function',
            userEmail: callerEmail || 'system@evreka.com',
            userName: 'Cloud Function'
          });
          
          logger.log(`✅ Üçüncü taraf portföy kaydına transaction eklendi: ${thirdPartyIpRecordId}`);
        }
      } catch (txErr) {
        logger.error('❌ Transaction eklenirken hata:', txErr);
        // Hata olsa bile task oluşturuldu, devam et
      }

      return { 
              taskId, 
              bulletinRecordId: createdBulletinRecordId,
              success: true, 
              message: `İtiraz işi başarıyla oluşturuldu: ${taskId}` 
            };
    } catch (error) {
      logger.error('❌ İtiraz işi oluşturma hatası:', error);
      throw new HttpsError('internal', `İş oluşturulamadı: ${error.message}`);
    }
  }
);

// functions/index.js

export const sendEmailNotificationV2 = onCall(
  { 
    region: "europe-west1",
    memory: "512MiB", // <--- BU SATIRI EKLEYİN (Varsayılan 256MB yetersiz kalıyor)
    timeoutSeconds: 120 // (Tavsiye) Büyük dosyalar için zaman aşımı süresini de artırabilirsiniz
  },
  async (request) => {
    // 1. GİRİŞ PARAMETRELERİ
    const { notificationId, userEmail: userEmailFromClient, mode, overrideSubject, overrideBody } = request.data || {};
    const isReminder = String(mode || "").toLowerCase() === "reminder";
    
    // Bildirim dokümanını çek
    const notificationRef = db.collection("mail_notifications").doc(notificationId);
    const notificationDoc = await notificationRef.get();
    if (!notificationDoc.exists) throw new HttpsError("not-found", "Bildirim bulunamadı.");
    const notificationData = notificationDoc.data();

    // Gönderici Doğrulama
    const callerEmail = (request.auth?.token?.email || "").toLowerCase();
    const userEmail = (userEmailFromClient || callerEmail || "").toLowerCase();
    if (!userEmail || !ALLOWED_SENDERS.has(userEmail)) {
        throw new HttpsError("permission-denied", "Bu kullanıcı adına gönderim yetkisi yok.");
    }

    // Alıcıları Belirle
    const getArrayOrNull = (v) => {
        if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x.trim() : x).filter(Boolean);
        if (typeof v === "string") return v.split(/[;,]\s*/).map(s => s.trim()).filter(Boolean);
        return null;
    };
    let toArr = getArrayOrNull(request.data.to) ?? getArrayOrNull(notificationData.toList) ?? [];
    let ccArr = getArrayOrNull(request.data.cc) ?? getArrayOrNull(notificationData.ccList) ?? [];
    const uniq = (a) => Array.from(new Set(a.map(s => String(s).toLowerCase().trim())));
    toArr = uniq(toArr);
    ccArr = uniq(ccArr).filter(x => !toArr.includes(x));
    const to = toArr.join(", ");
    const cc = ccArr.join(", ");

    if (!to && !cc) throw new HttpsError("failed-precondition", "Alıcı bulunamadı.");

    // Ekleri Hazırla
    const built = await buildNotificationAttachments(db, notificationData);
    const attachmentsToSend = built?.attachments?.length ? built.attachments : undefined;
    const footerItems = built?.footerItems || [];

    // İçerik Hazırlığı
    const stripBody = (html) => {
      if (!html) return "";
      const m = String(html).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      return m ? m[1] : String(html);
    };
    let subject = isReminder 
        ? (overrideSubject || `Hatırlatma: ${notificationData.subject || ""}`) 
        : (overrideSubject || notificationData.subject || "");
    
    // Standart Resmi Hatırlatma Metni
    const defaultReminderBody = `
        <p>Sayın İlgili,</p>
        <p>Bu e-posta ile, tarafınıza daha önce iletilen bildirimi hatırlatmak ve konuya ilişkin sizden geri dönüş beklediğimizi iletmek isteriz.</p>
        <br>
        <p>Saygılarımızla,<br><strong>EVREKA GROUP</strong></p>
    `;

    let htmlBody = isReminder 
        ? (overrideBody ? stripBody(overrideBody) : defaultReminderBody) 
        : (overrideBody ? stripBody(overrideBody) : notificationData.body || "");

    if (footerItems.length > 0) {
        const eklerHtml = footerItems.map(item => `• ${item}`).join("<br>");
        htmlBody += `<hr><p><strong>EKLER:</strong><br>${eklerHtml}</p>`;
    }

    // =================================================================
    // 🕵️ VERİ KURTARMA (DATA RECOVERY)
    // =================================================================
    
    let recordId = notificationData.relatedIpRecordId || null;
    const currentTaskId = notificationData.associatedTaskId || null;
    const sourceDocId = notificationData.sourceDocumentId || null;

    if (!recordId && (sourceDocId || currentTaskId)) {
        try {
            if (sourceDocId) {
                const indexedSnap = await db.collection('indexed_documents').doc(sourceDocId).get();
                if (indexedSnap.exists) recordId = indexedSnap.data().relatedIpRecordId;
            }
            if (!recordId && sourceDocId) {
                const pdfSnap = await db.collection('unindexed_pdfs').doc(sourceDocId).get();
                if (pdfSnap.exists) {
                    const d = pdfSnap.data();
                    recordId = d.matchedRecordId || d.relatedIpRecordId || d.ipRecordId;
                }
            }
            if (!recordId && currentTaskId) {
                const taskSnap = await db.collection('tasks').doc(currentTaskId).get();
                if (taskSnap.exists) recordId = taskSnap.data().relatedIpRecordId;
            }
            if(recordId) console.log(`✅ Record ID kurtarıldı: ${recordId}`);
        } catch (err) { console.warn("Veri kurtarma hatası:", err); }
    }

    // =================================================================
    // 🚀 THREAD (ZİNCİRLEME) MANTIĞI - FIXED (FORCE TYPE 2)
    // =================================================================
    
    // 1. Yeni Mail İçin STANDART Message-ID Oluştur
    const domainPart = userEmail.split('@')[1] || "evrekapatent.com";
    const uniquePart = Date.now().toString(36) + Math.random().toString(36).substr(2);
    const newMessageId = `<${uniquePart}@${domainPart}>`; 

    let threadIdToUse = null;
    let inReplyToToUse = null;  
    let referencesToUse = null; 
    let firstMessageId = null;  
    let finalSubject = subject; 
    let activeParentContext = null;
    const currentChildTypeId = String(notificationData.taskType || notificationData.notificationType || "1");

    if (recordId) {
        try {
            let parentContexts = ["1"];
            
            // --- [GÜNCELLEME 1: DİNAMİK ROTA ÖNCELİĞİ] ---
            // Eğer bildirim oluşturulurken 'dynamicParentContext' belirlendiyse (Örn: 24 -> 3),
            // veritabanındaki kuralları yok say ve doğrudan bu ID'yi kullan.
            if (notificationData.dynamicParentContext) {
                parentContexts = [String(notificationData.dynamicParentContext)];
                console.log(`📌 [THREAD] Dinamik Rota (Bildirimden): ${parentContexts[0]}`);
            } 
            else {
                // Dinamik rota yoksa veritabanındaki kurallara bak (Standart Akış)
                const settingsDoc = await db.doc("mailThreads/transactionTypeMatch").get();
                const allRules = settingsDoc.exists ? settingsDoc.data() : {};
                let rawRule = allRules[currentChildTypeId];
                
                if (rawRule) {
                    if (rawRule === "tbd") {
                        // Kural 'tbd' ama dynamicContext yoksa mecburen self (kendi ID'si)
                        parentContexts = [currentChildTypeId];
                    } else if (Array.isArray(rawRule.values)) {
                        parentContexts = rawRule.values.map(v => v.stringValue);
                    } else if (typeof rawRule === 'string') {
                        parentContexts = [rawRule];
                    } else if (Array.isArray(rawRule)) {
                        parentContexts = rawRule.map(String);
                    }
                }
            }
            // ---------------------------------------------

            // "1" (Eski Başvuru) -> "2" (Yeni Başvuru) Normalizasyonu (Her zaman geçerli)
            parentContexts = parentContexts.map(ctx => (ctx === "1" ? "2" : ctx));
            // Tekrarları temizle
            parentContexts = [...new Set(parentContexts)];

            console.log(`🔍 İşlem: ${currentChildTypeId}, Dosya: ${recordId}, Adaylar (Normalized): ${JSON.stringify(parentContexts)}`);

            for (const ctx of parentContexts) {
                const threadKey = `${recordId}_${ctx}`;
                const threadDoc = await db.collection("mailThreads").doc(threadKey).get();
                
                if (threadDoc.exists) {
                    const tData = threadDoc.data();
                    if (tData.threadId) {
                        threadIdToUse = tData.threadId;
                        activeParentContext = ctx;
                        finalSubject = tData.rootSubject; 
                        
                        firstMessageId = tData.firstMessageId; 
                        const lastMsgId = tData.lastMessageId;

                        if (lastMsgId) {
                            inReplyToToUse = lastMsgId;
                            // References: Varsa İlk + Son
                            if (firstMessageId && firstMessageId !== lastMsgId) {
                                referencesToUse = `${firstMessageId} ${lastMsgId}`;
                            } else {
                                referencesToUse = lastMsgId;
                            }
                        }
                                                       
                        console.log(`🔗 Zincir: ${threadIdToUse}, Reply: ${inReplyToToUse}, NewID: ${newMessageId}`);
                        break; 
                    }
                }
            }

            if (!threadIdToUse && parentContexts.length > 0) {
                activeParentContext = parentContexts[0]; 
                console.log(`🆕 Yeni Zincir Başlatılacak. Seçilen ID: ${activeParentContext}`);
            }

        } catch (e) { console.error("Threading hatası:", e); }
    } else {
        console.warn("⚠️ Record ID YOK! Threading atlanıyor.");
    }

    // =================================================================
    // 📤 GÖNDERİM İŞLEMİ
    // =================================================================

    const mailOptions = {
      fromName: "IPGate-EVREKA GROUP",
      replyTo: userEmail,
      to, cc, 
      subject: finalSubject, 
      html: htmlBody,
      attachments: attachmentsToSend
    };

    try {
      const sent = await sendViaGmailAsUser(
          userEmail, 
          mailOptions, 
          threadIdToUse, 
          inReplyToToUse, 
          referencesToUse,
          newMessageId 
      );

      // =================================================================
      // 💾 DB KAYITLARI
      // =================================================================
      
      if (recordId && sent.threadId && activeParentContext) {
          
          // 🔥 [DÜZELTME 2] Son güvenlik önlemi: activeParentContext hala "1" ise "2" yap.
          if (String(activeParentContext) === "1") {
              activeParentContext = "2";
              console.log("🛠️ DB Kaydı sırasında ID '1'den '2'ye zorla çevrildi.");
          }

          const threadKey = `${recordId}_${activeParentContext}`;
          
          const updateData = {
              ipRecordId: recordId,
              parentContext: activeParentContext,
              threadId: sent.threadId,            
              
              lastMessageId: newMessageId, 
              
              rootSubject: finalSubject,          
              lastTriggeringTaskId: currentTaskId || null, 
              lastTriggeringChildType: currentChildTypeId,
              lastUpdated: admin.firestore.FieldValue.serverTimestamp()
          };

          if (!firstMessageId) {
              updateData.firstMessageId = newMessageId;
          }

          await db.collection("mailThreads").doc(threadKey).set(updateData, { merge: true });
          console.log(`✅ MailThreads güncellendi: ${threadKey}`);
      }

      // Processed Mail Logu
      try {
        await db.collection('processedMailThreads').add({
            messageId: newMessageId, 
            gmailId: sent.id,        
            threadId: sent.threadId,
            from: userEmail,
            to: toArr, cc: ccArr,
            subject: finalSubject,
            originalSubject: subject,
            notificationId: notificationId || null,
            relatedIpRecordId: recordId || null, 
            parentContext: activeParentContext || null,
            associatedTaskId: currentTaskId || null,
            status: 'sent',
            sentAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (logErr) { console.error("Log hatası:", logErr); }

      // Notification Durum (GÜNCELLENDİ: Undefined hatası giderildi)
      const baseUpdate = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        sentBy: userEmail,
        provider: "gmail_api_dwd",
        gmailMessageId: sent?.id || null, 
        messageId: newMessageId, 
        gmailThreadId: sent?.threadId || null,
        status: isReminder ? (notificationData.status || "sent") : "sent"
      };

      // 🔥 KRİTİK DÜZELTME: Firestore undefined kabul etmez. 
      // Sadece hatırlatma değilse (ilk gönderimse) sentAt alanını ekliyoruz.
      if (!isReminder) {
          baseUpdate.sentAt = admin.firestore.FieldValue.serverTimestamp();
      }

      if (recordId && !notificationData.relatedIpRecordId) {
          baseUpdate.relatedIpRecordId = recordId;
      }
      
      if (isReminder) {
          baseUpdate.lastReminderAt = admin.firestore.FieldValue.serverTimestamp();
          baseUpdate.lastReminderBy = userEmail;
      }

      // Güncellemeyi yap
      await notificationRef.update(baseUpdate);

      return { success: true, message: "E-posta gönderildi.", id: sent?.id || null };

    } catch (error) {
      console.error("💥 Gönderim hatası:", error);
      await notificationRef.update({
        status: "failed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        errorInfo: error?.message || String(error)
      });
      throw new HttpsError("internal", "E-posta gönderilirken bir hata oluştu.", error?.message);
    }
  }
);

// =========================================================
//              SCHEDULER FONKSİYONLARI (v2)
// =========================================================

// Rate Limiting Function (Scheduled) (v2 sözdizimi)
export const cleanupEtebsLogsV2 = onSchedule(
    {
        schedule: 'every 24 hours',
        region: 'europe-west1'
    },
    async (event) => {
        console.log('🧹 ETEBS logs cleanup started');

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        try {
            const oldLogs = await adminDb.collection('etebs_logs')
                .where('timestamp', '<', thirtyDaysAgo)
                .limit(500)
                .get();

            const batch = db.batch();
            oldLogs.docs.forEach(doc => {
                batch.delete(doc.ref);
            });

            await batch.commit();

            console.log(`🗑️ Cleaned up ${oldLogs.docs.length} old ETEBS logs`);
        } catch (error) {
            console.error('❌ Cleanup error:', error);
        }

        return null;
    }
);

// =========================================================
//              FIRESTORE TRIGGER FONKSİYONLARI (v2)
// =========================================================
export const createMailNotificationOnDocumentIndexV2 = onDocumentCreated(
  {
    document: "indexed_documents/{docId}",
    region: "europe-west1",
  },
  async (event) => {
    const snap = event.data;
    const newDocument = snap.data();
    const docId = event.params.docId;

    console.log(`📄 Yeni belge algılandı: ${docId}`, newDocument);

    // --- Yardımcılar ---
    const normalizeType = (t) => {
      const s = String(t || "").toLowerCase();
      if (["marka", "trademark"].includes(s)) return "marka";
      if (["patent"].includes(s)) return "patent";
      if (["tasarım", "tasarim", "design"].includes(s)) return "tasarim";
      if (["dava", "litigation"].includes(s)) return "dava";
      if (["muhasebe", "finance", "accounting"].includes(s)) return "muhasebe";
      return s || "marka";
    };

    const dedupe = (arr) => Array.from(new Set((arr || []).filter(Boolean).map(x => String(x).trim())));

    const findRecipientsFromPersonsRelated = async (personIds, categoryKey) => {
      const to = [];
      const cc = [];
      if (!Array.isArray(personIds) || personIds.length === 0) return { to, cc };

      try {
        // "in" sorgusu 10 id ile sınırlıdır; 10'dan fazla ise parça parça sorgula
        const chunks = [];
        for (let i = 0; i < personIds.length; i += 10) {
          chunks.push(personIds.slice(i, i + 10));
        }
        for (const chunk of chunks) {
          const prSnap = await db
            .collection("personsRelated")
            .where("personId", "in", chunk)
            .get();

          prSnap.forEach((d) => {
            const pr = d.data();
            const email = (pr.email || "").trim();
            const isResp = pr?.responsible?.[categoryKey] === true;
            const n = pr?.notify?.[categoryKey] || {};
            if (!email || !isResp) return;
            if (n?.to === true) to.push(email);
            if (n?.cc === true) cc.push(email);
          });
        }
      } catch (e) {
        console.warn("personsRelated sorgusu hata:", e);
      }

      return { to: dedupe(to), cc: dedupe(cc) };
    };

    // --- Başlangıç değerleri ---
    const categoryKey = normalizeType(newDocument.mainProcessType || "marka");
    const notificationType = categoryKey;

    let toRecipients = [];
    let ccRecipients = [];
    let subject = "";
    let body = "";
    const missingFields = []; // sadece "recipients", "subject", "body" gibi gönderimi engelleyenler eklenecek

    try {
      // 1) Kural & Şablon (bulunamazsa bile fallback içerik oluşturacağız)
      let template = null;
      let templateId = null;

      try {
        const rulesSnapshot = await db
          .collection("template_rules")
          .where("sourceType", "==", "document")
          .where("mainProcessType", "==", newDocument.mainProcessType || "marka")
          .where("subProcessType", "==", newDocument.subProcessType || null)
          .limit(1)
          .get();

        if (!rulesSnapshot.empty) {
          const rule = rulesSnapshot.docs[0].data();
          templateId = rule.templateId || null;

          const templateSnapshot = await adminDb.collection("mail_templates").doc(templateId).get();
          if (templateSnapshot.exists) template = templateSnapshot.data();
          else console.warn(`⚠️ Şablon bulunamadı: ${templateId}`);
        } else {
          console.warn("⚠️ Kural bulunamadı (template_rules).");
        }
      } catch (e) {
        console.warn("Kural/şablon ararken hata:", e);
      }

      // 2) ALICILAR — ÖNCE taskOwner, SONRA applicants (clientId) fallback
      // Bu fonksiyon "indexed_documents" için çalışıyor; tipik olarak "clientId" mevcut.
      // Eğer dokümanda taskOwnerIds varsa önce onları kullan.
      const taskOwnerIds =
        (Array.isArray(newDocument.taskOwner) && newDocument.taskOwner) ||
        (Array.isArray(newDocument.taskOwnerIds) && newDocument.taskOwnerIds) ||
        [];

      if (taskOwnerIds.length > 0) {
        console.log("🎯 Öncelik: taskOwner -> personsRelated", taskOwnerIds);
        const fromOwners = await findRecipientsFromPersonsRelated(taskOwnerIds, categoryKey);
        toRecipients = fromOwners.to;
        ccRecipients = fromOwners.cc;
      }

      // Eğer taskOwner’dan alıcı çıkmadıysa → applicants (clientId) üzerinden dene
      const clientId = newDocument.clientId || null;
      if ((toRecipients.length + ccRecipients.length) === 0 && clientId) {
        console.log("↪️ taskOwner’dan alıcı çıkmadı; applicants (clientId) fallback deneniyor:", clientId);
        const fromApplicantsPR = await findRecipientsFromPersonsRelated([clientId], categoryKey);
        toRecipients = fromApplicantsPR.to;
        ccRecipients = fromApplicantsPR.cc;

        // Hâlâ yoksa getRecipientsByApplicantIds ile son kez dene
        if ((toRecipients.length + ccRecipients.length) === 0) {
          // Eğer ipRecord.applicants yoksa sentetik applicants [{id: clientId}]
          const rec = await getRecipientsByApplicantIds([{ id: clientId }], categoryKey);
          toRecipients = rec?.to || [];
          ccRecipients = rec?.cc || [];
        }
      }

      console.log("📧 FINAL RECIPIENTS", { toRecipients, ccRecipients });

      // 3) ŞABLON/İÇERİK — Şablon yoksa da boş bırakma (missing_info olmasın diye fallback oluştur)
      if (template) {
      subject = String(template.subject || "");

      // Varsayılan: body
      let rawBody = String(template.body || "");

      // ✅ SADECE tmpl_50_document için body1/body2 seçimi
      if (String(templateId || "") === "tmpl_50_document") {
        // recordOwnerType tespiti: önce ipRecords'tan bak
        const recordId =
          newDocument.relatedIpRecordId ||
          newDocument.matchedRecordId ||
          newDocument.ipRecordId ||
          null;

        let detectedType = null; // 'self' | 'third_party'

        let ipRecordData = null;
        if (recordId) {
          try {
            const ipSnap = await adminDb.collection("ipRecords").doc(recordId).get();
            if (ipSnap.exists) ipRecordData = ipSnap.data() || {};
          } catch (e) {
            console.warn("ipRecords okunamadı:", e);
          }
        }

        const dbType = ipRecordData?.recordOwnerType
          ? String(ipRecordData.recordOwnerType).trim().toLowerCase()
          : null;

        if (dbType === "self" || dbType === "third_party") {
          detectedType = dbType;
        } else {
          // DB'de yoksa: müvekkil(clientId) applicant mı? -> self, değilse third_party
          const clientId = String(newDocument.clientId || "").trim();
          const apps = Array.isArray(ipRecordData?.applicants) ? ipRecordData.applicants : [];
          const isClientApplicant =
            clientId && apps.length > 0
              ? apps.some((a) => String(a?.id || a?.personId || "").trim() === clientId)
              : false;

          detectedType = isClientApplicant ? "self" : "third_party";
        }

        // body seç
        if (detectedType === "self" && template.body1 && String(template.body1).trim() !== "") {
          rawBody = String(template.body1);
        } else if (detectedType === "third_party" && template.body2 && String(template.body2).trim() !== "") {
          rawBody = String(template.body2);
        }
      }

      body = rawBody;

      const applicationNo =
        newDocument.applicationNumber ||
        newDocument.applicationNo ||
        newDocument.appNo ||
        "";

      const parameters = {
        ...newDocument,
        muvekkil_adi: newDocument.clientName || newDocument.ownerName || "Değerli Müvekkil",
        basvuru_no: applicationNo,
      };

      subject = subject.replace(/{{\s*([\w.]+)\s*}}/g, (_, k) => parameters[k] ?? "");
      body    = body.replace(/{{\s*([\w.]+)\s*}}/g, (_, k) => parameters[k] ?? "");
    }

      else {
        // Temel fallback içerik
        subject = `[${notificationType.toUpperCase()}] Yeni Evrak`;
        body = [
          `Merhaba,`,
          ``,
          `Sistemimize yeni bir evrak eklendi.`,
          `Evrak No / Başvuru No: ${newDocument.applicationNumber || newDocument.applicationNo || newDocument.appNo || "-"}`,
          ``,
          `Saygılarımızla`
        ].join("\n");
      }

      // 4) STATUS — SADE KURAL: sadece alıcı + içerik
      if (!subject?.trim()) missingFields.push("subject");
      if (!body?.trim())    missingFields.push("body");

      const hasRecipients = (toRecipients.length + ccRecipients.length) > 0;
      const hasContent    = !missingFields.includes("subject") && !missingFields.includes("body");
      const status        = (hasRecipients && hasContent) ? "pending" : "missing_info";

      if (!hasRecipients) missingFields.push("recipients");

      // 5) Firestore’a yaz — UI filtreleriyle uyumlu alanlar


      const finalStatus = (hasRecipients && hasContent) ? "awaiting_client_approval" : "missing_info";
      if (!hasRecipients) missingFields.push("recipients");
      const notificationDoc = {
        toList: dedupe(toRecipients),
        ccList: dedupe(ccRecipients),

        clientId: newDocument.clientId || null,
        subject,
        body,
        status: finalStatus, // <<< DEĞİŞTİ
        mode: "draft",
        isDraft: true,

        assignedTo_uid: selcanUserId,         // <<< YENİ EKLENDİ
        assignedTo_email: selcanUserEmail,    // <<< YENİ EKLENDİ

        sourceDocumentId: docId,
        relatedIpRecordId: newDocument.relatedIpRecordId || null,
        associatedTaskId: null,
        associatedTransactionId: null,
        templateId: templateId || null,

        notificationType,
        source: "document_index",
        missingFields,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
  
      console.log("📥 mail_notifications.add input:", {
        ...notificationDoc,
        createdAt: "[serverTimestamp]",
        updatedAt: "[serverTimestamp]",
      });

      const ref = await adminDb.collection("mail_notifications").add(notificationDoc);
      console.log(`✅ Mail bildirimi '${status}' olarak oluşturuldu.`, { id: ref.id });

      return null;
    } catch (error) {
      console.error("Mail bildirimi oluşturulurken hata:", error);
      return null;
    }
  }
);

export const createMailNotificationOnDocumentStatusChangeV2 = onDocumentUpdated(
  {
    document: "unindexed_pdfs/{docId}",
    region: "europe-west1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return null;

    const before = change.before.data() || {};
    const after  = change.after.data()  || {};
    const docId  = event.params.docId;

    // Sadece indexed geçişinde çalış
    if (!(before.status !== "indexed" && after.status === "indexed")) {
      return null;
    }

    console.log(`🚀 [OTOMASYON] Belge indexlendi: ${docId}`);

    // --- DEĞİŞKENLER ---
    let rule = null;
    let template = null;
    let client = null;
    let subject = ""; 
    let body = "";
    let isEvaluationRequired = false;
    
    let ipRecordData = null;
    let applicants = [];
    
    // Veritabanından çekilecekler
    let fetchedTxnData = null;      
    let parentTxnData = null;       
    let fetchedTaskData = null;     
    
    let templateSearchType = null;  
    let namingTargetType = null;    
    let calculatedDeadline = null;  
    
    let taskOwnerIds = [];

    // İtiraz Bilgileri
    let oppositionOwner = null;
    let oppositionFileUrl = null;
    let oppositionEpatsFileUrl = null;

    const associatedTransactionId = after.associatedTransactionId || after.finalTransactionId;
    const recordId = after.matchedRecordId || after.relatedIpRecordId || after.ipRecordId;

    // A) VERİLERİ TOPLA
    try {
        if (recordId) {
             const ipDoc = await adminDb.collection("ipRecords").doc(recordId).get();
             if (ipDoc.exists) {
                 ipRecordData = ipDoc.data();
                 applicants = ipRecordData.applicants || [];
                 
                 if (associatedTransactionId) {
                     const txnRef = adminDb.collection("ipRecords").doc(recordId).collection("transactions").doc(associatedTransactionId);
                     let txnSnap = await txnRef.get();
                     // Transaction henüz yazılmadıysa kısa bir bekleme
                     if (!txnSnap.exists) {
                         await new Promise(r => setTimeout(r, 500));
                         txnSnap = await txnRef.get();
                     }

                     if (txnSnap.exists) {
                         fetchedTxnData = txnSnap.data();
                         templateSearchType = fetchedTxnData.type ? String(fetchedTxnData.type) : null;
                         namingTargetType = templateSearchType;

                         // --- İtiraz Bilgilerini Çek (Child) ---
                         if (fetchedTxnData.oppositionOwner) oppositionOwner = fetchedTxnData.oppositionOwner;
                         if (fetchedTxnData.oppositionPetitionFileUrl) oppositionFileUrl = fetchedTxnData.oppositionPetitionFileUrl;
                          
                         if (fetchedTxnData.oppositionEpatsPetitionFileUrl) oppositionEpatsFileUrl = fetchedTxnData.oppositionEpatsPetitionFileUrl;
                         if (fetchedTxnData.parentId) {
                             const parentSnap = await adminDb.collection("ipRecords").doc(recordId).collection("transactions").doc(fetchedTxnData.parentId).get();
                             if (parentSnap.exists) {
                                 parentTxnData = parentSnap.data();
                                 namingTargetType = parentTxnData.type ? String(parentTxnData.type) : null;

                                 // --- İtiraz Bilgilerini Çek (Parent - Varsa üzerine yaz) ---
                                 if (parentTxnData.oppositionOwner) oppositionOwner = parentTxnData.oppositionOwner;
                                 if (parentTxnData.oppositionPetitionFileUrl) oppositionFileUrl = parentTxnData.oppositionPetitionFileUrl;
                                 if (parentTxnData.oppositionEpatsPetitionFileUrl) oppositionEpatsFileUrl = parentTxnData.oppositionEpatsPetitionFileUrl;
                             }
                         }
                         
                         if (fetchedTxnData.triggeringTaskId) {
                            const t = await adminDb.collection("tasks").doc(String(fetchedTxnData.triggeringTaskId)).get();
                            if (t.exists) {
                                fetchedTaskData = t.data();
                                let rawOwner = fetchedTaskData.taskOwner || fetchedTaskData.taskOwnerIds || fetchedTaskData.taskOwnerId;
                                if (typeof rawOwner === 'string') rawOwner = [rawOwner];
                                if (Array.isArray(rawOwner)) taskOwnerIds.push(...rawOwner);
                            }
                         }
                     }
                 }
             }
        } 
    } catch (error) { console.error("❌ Veri toplama hatası:", error); }

    // --- İŞLEM ADI VE RESMİ SÜRE HESAPLAMA ---
    let finalIslemTanimlamasi = null;

    if (namingTargetType) {
        if (!(String(namingTargetType) === '24' && !parentTxnData)) {
            try {
                const typeDoc = await adminDb.collection('transactionTypes').doc(String(namingTargetType)).get();
                if (typeDoc.exists) {
                    const typeData = typeDoc.data();
                    finalIslemTanimlamasi = typeData.alias || typeData.name;
                    
                    // İşlem tipine özel süre hesaplama
                    if (templateSearchType && fetchedTxnData?.date) {
                        let duePeriod = typeData.duePeriod;
                        if (String(namingTargetType) !== String(templateSearchType)) {
                             const childTypeDoc = await adminDb.collection('transactionTypes').doc(String(templateSearchType)).get();
                             if (childTypeDoc.exists) duePeriod = childTypeDoc.data().duePeriod;
                        }

                        if (duePeriod && !isNaN(duePeriod)) {
                            const tebligDate = new Date(fetchedTxnData.date);
                            let targetDate = new Date(tebligDate);
                            const originalDay = targetDate.getDate();
                            targetDate.setMonth(targetDate.getMonth() + Number(duePeriod));
                            if (targetDate.getDate() !== originalDay) targetDate.setDate(0); 

                            const maxIter = 30; 
                            let iter = 0;
                            while ((isWeekend(targetDate) || isHoliday(targetDate, TURKEY_HOLIDAYS)) && iter < maxIter) {
                                targetDate.setDate(targetDate.getDate() + 1);
                                iter++;
                            }
                            calculatedDeadline = targetDate;
                            console.log(`✅ Hesaplanan Son Tarih: ${calculatedDeadline.toISOString().split('T')[0]}`);
                        }
                    }
                }
            } catch (e) { console.error("❌ Tip sorgu hatası:", e); }
        }
    }

    if (!finalIslemTanimlamasi) {
        const rawMainProcessType = String(after.mainProcessType || ipRecordData?.type || "marka");
        const mainTypeMap = { 'marka': 'Marka Başvurusu', 'trademark': 'Marka Başvurusu', 'patent': 'Patent Başvurusu' };
        finalIslemTanimlamasi = mainTypeMap[rawMainProcessType.toLowerCase()] || `${rawMainProcessType.toUpperCase()} İşlemi`;
    }

    // --- FORMATLAYICI ---
    const formatDate = (val) => {
        if (!val) return "-";
        try {
            if (val && typeof val.toDate === 'function') return val.toDate().toLocaleDateString("tr-TR");
            if (val && val._seconds) return new Date(val._seconds * 1000).toLocaleDateString("tr-TR");
            const d = new Date(val);
            if (!isNaN(d.getTime())) return d.toLocaleDateString("tr-TR");
            return "-";
        } catch (e) { return "-"; }
    };

    // --- ENRICHED DATA ---
    let enrichedData = {
        applicantNames: "-", classNumbers: "-", applicationDate: "-",
        markImageUrl: "", markName: "-", tebligTarihiFormatted: "-", deadlineFormatted: "-",
        itirazSahibi: "-" 
    };

    if (oppositionOwner) {
        enrichedData.itirazSahibi = oppositionOwner;
    }

    if (ipRecordData) {
        const clean = (val) => (val ? String(val).trim() : "");
        enrichedData.markName = clean(ipRecordData.title) || clean(ipRecordData.markName) || "-";
        enrichedData.markImageUrl = clean(ipRecordData.brandImageUrl) || clean(ipRecordData.trademarkImage) || clean(ipRecordData.publicImageUrl) || "";
        enrichedData.applicationDate = formatDate(ipRecordData.applicationDate);

        // [GÜNCELLEME] BAŞVURU SAHİBİ ÇÖZÜMLEME (HYBRID: DB + DIRECT NAME)
        try {
            const namesList = [];
            const apps = ipRecordData.applicants || applicants || [];
            
            for (const app of apps) {
                // 1. Durum: Veri doğrudan metin ise
                if (typeof app === 'string') {
                    namesList.push(app);
                }
                // 2. Durum: Veri nesne ise
                else if (typeof app === 'object' && app !== null) {
                    let resolvedName = null;

                    // A) ID varsa veritabanından çekmeyi dene
                    if (app.id) {
                        const pDoc = await adminDb.collection("persons").doc(app.id).get();
                        if (pDoc.exists) {
                            resolvedName = pDoc.data().name || pDoc.data().companyName;
                        }
                    }

                    // B) Veritabanında yoksa (örn: bulletin_holder...) veya ID yoksa, 
                    // nesnenin üzerindeki 'name' alanını kullan
                    if (!resolvedName && app.name) {
                        resolvedName = app.name;
                    }

                    if (resolvedName) {
                        namesList.push(resolvedName);
                    }
                }
            }
            
            if (namesList.length > 0) {
                enrichedData.applicantNames = namesList.join(", ");
            }
        } catch (e) {
            console.warn("Applicant name resolve error:", e);
        }

        const extractClassNo = (val) => String(val).match(/\d+/)?.[0] || "";
        if (ipRecordData.goodsAndServicesByClass && Array.isArray(ipRecordData.goodsAndServicesByClass)) {
            enrichedData.classNumbers = ipRecordData.goodsAndServicesByClass.map(item => extractClassNo(item.classNo)).filter(Boolean).join(", ");
        } else if (ipRecordData.niceClasses) {
            const arr = Array.isArray(ipRecordData.niceClasses) ? ipRecordData.niceClasses : [String(ipRecordData.niceClasses)];
            enrichedData.classNumbers = arr.map(c => extractClassNo(c)).filter(Boolean).join(", ");
        }
    }
    
    const findDate = (...candidates) => candidates.find(d => d !== undefined && d !== null);

    const rawTeblig = findDate(
        fetchedTaskData?.details?.tebligTarihi, 
        fetchedTaskData?.tebligTarihi,          
        fetchedTxnData?.date,
        fetchedTxnData?.tebligTarihi
    );

    const rawDeadline = findDate(
        calculatedDeadline,                     
        fetchedTaskData?.officialDueDate,       
        fetchedTaskData?.details?.resmiSonTarih,
        fetchedTxnData?.deadline
    );
    
    enrichedData.tebligTarihiFormatted = formatDate(rawTeblig);
    enrichedData.deadlineFormatted = formatDate(rawDeadline);

    // ===============================================================
    //  DİNAMİK KARAR VE DAVA ANALİZİ (GÜNCELLENDİ)
    // ===============================================================
    
    // 1. Portföy Kontrolü (Self mi?)
    const isPortfolio = ipRecordData?.recordOwnerType === 'self';

    let decisionAnalysis = {
        isLawsuitRequired: false,
        resultText: "-",          
        statusText: "-",          
        statusColor: "#333",      
        summaryText: "",          
        boxColor: "#e8f0fe",      
        boxBorder: "#0d6efd"      
    };

    const txType = String(templateSearchType);

    // Tip 31-36 Mantık Tablosu
    if (["31", "32", "33", "34", "35", "36"].includes(txType)) {
        
        // --- 31: Başvuru Sahibi - İtiraz Kabul ---
        if (txType === "31") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { 
                // Self -> Lehimize (Başvurumuz Kabul Edildi / İtiraz Süreci Bitti)
                decisionAnalysis.statusText = "LEHİMİZE (Kazanıldı)";
                decisionAnalysis.statusColor = "#237804";
                decisionAnalysis.isLawsuitRequired = false;
                decisionAnalysis.summaryText = "Başvurumuza ilişkin yapılan itiraz kabul edilmiştir (Başvuru Sahibi lehine sonuç). Tescil süreci devam edecektir.";
            } else { 
                // 3. Taraf -> Aleyhimize (Rakip Kazandı, Biz Kaybettik)
                decisionAnalysis.statusText = "ALEYHİMİZE (Rakip Kazandı)";
                decisionAnalysis.statusColor = "#d32f2f";
                decisionAnalysis.isLawsuitRequired = true;
                decisionAnalysis.summaryText = "Rakip başvuru lehine karar verilmiştir (Bizim itirazımız reddedilmiş gibi işlem görür). Bu karara karşı dava açılması gerekmektedir.";
            }
        }
        
        // --- 32: Başvuru Sahibi - İtiraz Kısmen Kabul ---
        else if (txType === "32") {
            decisionAnalysis.resultText = "KISMEN KABUL";
            decisionAnalysis.statusText = "KISMEN ALEYHE";
            decisionAnalysis.statusColor = "#d97706";
            decisionAnalysis.isLawsuitRequired = true; // Her iki taraf için de kayıp kısımlar olabilir
            
            if (isPortfolio) {
                decisionAnalysis.summaryText = "Başvurumuz kısmen kabul edilmiş, kısmen reddedilmiştir. Reddedilen sınıflar için dava açma hakkımız doğmuştur.";
            } else {
                decisionAnalysis.summaryText = "Rakip başvuru kısmen kabul edilmiştir. Rakibin kazandığı (bizim itirazımızın reddedildiği) kısımlar için dava açma hakkımız vardır.";
            }
        }

        // --- 33: Başvuru Sahibi - İtiraz Ret ---
        else if (txType === "33") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { 
                // Self -> Aleyhimize (Başvurumuz Reddedildi)
                decisionAnalysis.statusText = "ALEYHİMİZE (Başvurumuz Reddedildi)";
                decisionAnalysis.statusColor = "#d32f2f";
                decisionAnalysis.isLawsuitRequired = true;
                decisionAnalysis.summaryText = "Başvurumuza ilişkin itiraz süreci aleyhimize sonuçlanmış ve başvurumuz reddedilmiştir. Dava açılması gerekmektedir.";
            } else { 
                // 3. Taraf -> Lehimize (Rakip Reddedildi)
                decisionAnalysis.statusText = "LEHİMİZE (Rakip Reddedildi)";
                decisionAnalysis.statusColor = "#237804";
                decisionAnalysis.isLawsuitRequired = false;
                decisionAnalysis.summaryText = "Başvuru sahibi markasının reddedilmesine karar verilmiştir. Karar lehimizedir.";
            }
        }

        // --- 34: İtiraz Sahibi - İtiraz Kabul ---
        else if (txType === "34") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { 
                // Self -> Aleyhimize (Bizim Yaptığımız İtiraz Kabul Edilmedi / Başvuru Aleyhine Sonuçlanan Durum?)
                // DÜZELTME: "İtiraz Sahibi Kabul" genelde "İtiraz Edenin Talebi Kabul" demektir.
                // Eğer Self isek ve İtiraz Sahibiysek -> Kazanmışızdır.
                // Ancak "itiraz sahibi kabul ise benim aleyhime" dediniz (Self senaryosunda).
                // BU, SİZİN VERDİĞİNİZ KURALA GÖRE AYARLANIYOR:
                decisionAnalysis.statusText = "ALEYHİMİZE (Karşı Taraf Kazandı)";
                decisionAnalysis.statusColor = "#d32f2f";
                decisionAnalysis.isLawsuitRequired = true;
                decisionAnalysis.summaryText = "İtiraz sahibi lehine karar verilmiştir (Aleyhimize). Dava açılması gerekmektedir.";
            } else { 
                // 3. Taraf -> Lehimize
                decisionAnalysis.statusText = "LEHİMİZE";
                decisionAnalysis.statusColor = "#237804";
                decisionAnalysis.isLawsuitRequired = false;
                decisionAnalysis.summaryText = "İtiraz sahibi lehine verilen karar bizim lehimizedir.";
            }
        }

        // --- 35: İtiraz Sahibi - İtiraz Kısmen Kabul ---
        else if (txType === "35") {
            decisionAnalysis.resultText = "KISMEN KABUL";
            decisionAnalysis.statusText = "KISMEN ALEYHE";
            decisionAnalysis.statusColor = "#d97706";
            decisionAnalysis.isLawsuitRequired = true;
            
            if (isPortfolio) {
                decisionAnalysis.summaryText = "Karar kısmen aleyhimize sonuçlanmıştır. Kaybettiğimiz kısımlar için dava açma hakkımız vardır.";
            } else {
                decisionAnalysis.summaryText = "Karar kısmen lehimize, kısmen aleyhimizedir. Aleyhe olan kısımlar için dava açılabilir.";
            }
        }

        // --- 36: İtiraz Sahibi - İtiraz Ret ---
        else if (txType === "36") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { 
                // Self -> Lehimize (İtiraz Sahibi Reddedildi -> Biz Kurtulduk)
                // Kuralınız: "itiraz sahibi ret ise benim lehime"
                decisionAnalysis.statusText = "LEHİMİZE (İtiraz Reddedildi)";
                decisionAnalysis.statusColor = "#237804";
                decisionAnalysis.isLawsuitRequired = false;
                decisionAnalysis.summaryText = "İtiraz sahibinin talebi reddedilmiştir. Karar lehimizedir.";
            } else { 
                // 3. Taraf -> Aleyhimize (Biz İtiraz Ettik, Reddedildi)
                decisionAnalysis.statusText = "ALEYHİMİZE (İtirazımız Reddedildi)";
                decisionAnalysis.statusColor = "#d32f2f";
                decisionAnalysis.isLawsuitRequired = true;
                decisionAnalysis.summaryText = " Yaptığımız itiraz nihai olarak reddedilmiştir. Karşı taraf markası için tescil süreci devam edecektir. Bu noktadan sonra YİDK kararının iptali ve markanın tescil edilmesi halinde hükümsüzlüğü talepli, yukarıda belirtilen tarihe kadar dava açma hakkınız bulunmaktadır. ";
            }
        }
    } 
    // Tip 29 (Kısmen) ve 30 (Ret) Standart
    else if (txType === "29") {
        decisionAnalysis = { isLawsuitRequired: true, resultText: "KISMEN KABUL", statusText: "KISMEN RET", statusColor: "#d97706", summaryText: "Karara itirazımız kısmen kabul edilmiştir." };
    } 
    else if (txType === "30") {
        decisionAnalysis = { isLawsuitRequired: true, resultText: "RET", statusText: "NİHAİ RET", statusColor: "#d32f2f", summaryText: "Karara itirazımız reddedilmiştir." };
    }

    // --- DAVA TARİHİ HESAPLAMA (Eğer Dava Gerekliyse) ---
    // Sadece lawsuitRequired true ise ve 31-36 veya 29-30 ise hesapla
    let davaSonTarihi = "-";
    const lawsuitTypes = ["29", "30", "31", "32", "33", "34", "35", "36"];
    
    if (decisionAnalysis.isLawsuitRequired && lawsuitTypes.includes(txType) && fetchedTxnData?.date) {
        const tebligDate = new Date(fetchedTxnData.date);
        let targetDate = new Date(tebligDate);
        const originalDay = targetDate.getDate();
        
        targetDate.setMonth(targetDate.getMonth() + 2);
        if (targetDate.getDate() !== originalDay) targetDate.setDate(0); 

        const maxIter = 30; 
        let iter = 0;
        while ((isWeekend(targetDate) || isHoliday(targetDate, TURKEY_HOLIDAYS)) && iter < maxIter) {
            targetDate.setDate(targetDate.getDate() + 1);
            iter++;
        }
        davaSonTarihi = formatDate(targetDate);
        console.log(`⚖️ Dava Tarihi (${txType}): ${davaSonTarihi}`);
    }

    // Renk Ayarları (UI için)
    if (decisionAnalysis.isLawsuitRequired) {
        decisionAnalysis.boxColor = "#fff2f0"; 
        decisionAnalysis.boxBorder = "#ff4d4f";
    } else {
        decisionAnalysis.boxColor = "#f6ffed"; 
        decisionAnalysis.boxBorder = "#52c41a";
    }

    // ===============================================================

    // B) Notification Type
    const safeMainProcessType = String(after.mainProcessType || ipRecordData?.type || "marka").toLowerCase();
    const notificationType = (safeMainProcessType === 'marka' || safeMainProcessType === 'trademark') ? 'marka' : safeMainProcessType;

    // C) Alıcıları Belirle
    let toRecipients = [];
    let ccRecipientsSet = new Set();

    async function findRecipientsFromPersonsRelated(personIds, categoryKey) {
      const to = [], cc = [];
      if (!Array.isArray(personIds) || personIds.length === 0) return { to, cc };
      for (let i = 0; i < personIds.length; i += 10) {
        const batch = personIds.slice(i, i + 10);
        const prs = await adminDb.collection("personsRelated").where("personId", "in", batch).get();
        prs.forEach((doc) => {
          const r = doc.data() || {};
          const email = String(r.email || "").trim();
          if (email && r?.responsible?.[categoryKey] === true) {
              const notify = r?.notify?.[categoryKey] || {};
              if (notify.to === true) to.push(email);
              else if (notify.cc === true) cc.push(email);
              else to.push(email);
          }
        });
      }
      return { to, cc };
    }

    const owners = ipRecordData?.taskOwner || [];
    taskOwnerIds.push(...owners);
    taskOwnerIds = [...new Set(taskOwnerIds)]; 

    if (taskOwnerIds.length > 0) {
      const fromOwners = await findRecipientsFromPersonsRelated(taskOwnerIds, notificationType);
      toRecipients.push(...fromOwners.to);
      fromOwners.cc.forEach((e) => ccRecipientsSet.add(e));
      if (toRecipients.length === 0 && ccRecipientsSet.size === 0) {
          for (const uid of taskOwnerIds) {
              const p = await adminDb.collection("persons").doc(String(uid)).get();
              if (p.exists && p.data().email) toRecipients.push(p.data().email);
          }
      }
    }

    // 🔥 GÜVENLİK DUVARI: Yedek planda rakibe mail atmayı engelle
    if ((toRecipients.length + ccRecipientsSet.size) === 0) {
      const isSelfRecord = !ipRecordData?.recordOwnerType || ipRecordData.recordOwnerType === 'self';
      
      if (isSelfRecord) {
          // Kendi markamızsa, fallback olarak applicants'a bakabiliriz.
          const rec = await getRecipientsByApplicantIds(applicants, notificationType);
          (rec.to || []).forEach((e) => toRecipients.push(e));
          (rec.cc || []).forEach((e) => ccRecipientsSet.add(e));
      } else {
          // Üçüncü taraf markasıysa (Third Party), ASLA rakibe mail atma.
          console.log(`⚠️ Güvenlik Duvarı: Üçüncü taraf (third_party) dosyası olduğu için rakip 'applicants' listesine mail atılması engellendi. Bildirim 'Eksik Bilgi' statüsüne düşürülecek.`);
      }
    }

    if (templateSearchType) {
      const extraCc = await getCcFromEvrekaListByTransactionType(templateSearchType);
      for (const e of (extraCc || [])) ccRecipientsSet.add(e);
    }

    toRecipients = Array.from(new Set(toRecipients.map((s) => s.trim()).filter(Boolean)));
    const ccRecipients = Array.from(ccRecipientsSet).filter((e) => !toRecipients.includes(e));

// --- GÜNCELLENMİŞ CLIENT TESPİT MANTIĞI ---

    let targetClientId = after.clientId;

    // 1. Adım: Dokümanda Client ID yoksa, İlişkili Görevden (Task) bulmaya çalış
    if (!targetClientId && fetchedTaskData) {
        // A) Task içinde explicit clientId var mı?
        if (fetchedTaskData.clientId) {
            targetClientId = fetchedTaskData.clientId;
            console.log(`🎯 Client ID, Task.clientId alanından alındı: ${targetClientId}`);
        }
        // B) Yoksa, Task Owner (Görev Sahibi) kim? (Third Party için kritik nokta burası)
        else if (fetchedTaskData.taskOwner) {
            const owners = Array.isArray(fetchedTaskData.taskOwner) ? fetchedTaskData.taskOwner : [fetchedTaskData.taskOwner];
            if (owners.length > 0 && owners[0]) {
                targetClientId = owners[0];
                console.log(`🎯 Client ID, Task.taskOwner alanından alındı: ${targetClientId}`);
            }
        }
    }

    // 2. Adım: Hala bulunamadıysa Applicant'a bak (Self portföyler için standart yöntem)
    if (!targetClientId && applicants.length > 0 && applicants[0].id) {
        targetClientId = applicants[0].id;
        console.log(`🎯 Client ID, Applicant bilgisinden alındı: ${targetClientId}`);
    }

    // 3. Adım: ID bulunduysa veritabanından ayarları çek
    if (targetClientId) {
        const clientSnapshot = await adminDb.collection("persons").doc(targetClientId).get();
        if (clientSnapshot.exists) {
            client = clientSnapshot.data();
            isEvaluationRequired = client.is_evaluation_required === true;
            console.log(`👤 Client Detayı: ${client.name || client.companyName} | Değerlendirme Gerekli mi: ${isEvaluationRequired}`);
        } else {
            console.log(`⚠️ ID (${targetClientId}) var ama Persons tablosunda kayıt bulunamadı.`);
        }
    }

    // 4. Adım: Hiçbir şekilde DB kaydı bulunamadıysa, Applicant ismini "Client" gibi kullan (Fallback)
    if (!client && applicants.length > 0) {
        client = { name: applicants[0].name, id: applicants[0].id };
        console.log(`👤 Client DB'de bulunamadı, Applicant ismi kullanılıyor: ${client.name}`);
    }
    
    if (!client) {
        console.log(`⚠️ HATA: Client bilgisi hiçbir kaynaktan bulunamadı!`);
    }

    // --- ŞABLON EŞLEŞTİRME ---
    const querySubType = after.subProcessType || templateSearchType || null; 
    let subTypeOptions = [];
    if (querySubType) {
        subTypeOptions = [String(querySubType), Number(querySubType)].filter(v => !isNaN(v) || typeof v === 'string');
        if (isNaN(Number(querySubType))) subTypeOptions = [String(querySubType)];
    }

    if (subTypeOptions.length > 0) {
        const rulesSnapshot = await adminDb
          .collection("template_rules")
          .where("sourceType", "==", "document")
          .where("subProcessType", "in", subTypeOptions) 
          .get();

        if (!rulesSnapshot.empty) {
          let possibleMainTypes = [safeMainProcessType.toLowerCase()];
          if (possibleMainTypes.includes('marka')) possibleMainTypes.push('trademark');
          if (possibleMainTypes.includes('trademark')) possibleMainTypes.push('marka');
          
          let matchedDoc = rulesSnapshot.docs.find(doc => {
              const ruleMainType = String(doc.data().mainProcessType || "").toLowerCase();
              return possibleMainTypes.includes(ruleMainType);
          });

          if (!matchedDoc && rulesSnapshot.size > 0) matchedDoc = rulesSnapshot.docs[0];

          if (matchedDoc) {
             rule = matchedDoc.data();
             const templateSnapshot = await adminDb.collection("mail_templates").doc(rule.templateId).get();
             if (templateSnapshot.exists) template = templateSnapshot.data();
          }
        }
    }

// ---------------------------------------------------------------------------------------
    // [GÜNCELLENDİ v12] ID KESİN ÇÖZÜM & İÇERİK GARANTİSİ
    // ---------------------------------------------------------------------------------------
    
    // 1. ID NORMALİZASYONU (EN BAŞTA)
    // Veritabanından veya herhangi bir yerden "1" gelirse, bunu "2" olarak eziyoruz.
    if (String(namingTargetType) === "1") {
        namingTargetType = "2";
    }

    let parentTemplateSubject = null;
    let foundInThread = false;
    let forcedThreadId = null; // ID'yi zorlamak için yeni değişken

    // İşlem tipini al
    const currentSubTypeId = String(templateSearchType || after.subProcessType || after.transactionType || "").trim();
    
    // Varsayılan hedef
    let potentialTargetTypes = namingTargetType ? [String(namingTargetType)] : [];
    
    console.log(`🔍 Konu Analizi: İşlem=${currentSubTypeId}, HedefID=${namingTargetType}`);

    // 2. Mapping Kontrolü
    if (currentSubTypeId) {
        try {
            const settingsDoc = await adminDb.collection("mailThreads").doc("transactionTypeMatch").get();
            if (settingsDoc.exists) {
                const allRules = settingsDoc.data();
                let rawRule = allRules[currentSubTypeId] || allRules[Number(currentSubTypeId)];
                
                // --- [GÜNCELLEME 2: 24, 25, 40 İÇİN ZORUNLU PARENT ARAMA] ---
                const forceDynamicTypes = ["24", "25", "40"];
                if (forceDynamicTypes.includes(String(currentSubTypeId))) {
                    rawRule = "tbd"; 
                }
                
                if (rawRule) {
                    if (rawRule === "tbd") {
                        // A) Tip 19 ve 20 için ÖZEL MANTIK (Self/ThirdParty)
                        if (["19", "20"].includes(currentSubTypeId)) {
                            const isSelf = ipRecordData?.recordOwnerType === 'self';
                            potentialTargetTypes = isSelf ? ["2"] : ["20"];
                            console.log(`🔀 Mapping 'tbd' (Tip ${currentSubTypeId}, ${isSelf?'Self':'3rd'}) -> Hedef: ${potentialTargetTypes[0]}`);
                        }
                        // B) Diğerleri (24, 25, 40 vb.) için PARENT ARAMA
                        else {
                            if (parentTxnData && parentTxnData.type) {
                                const pType = String(parentTxnData.type); // Örn: "3"
                                potentialTargetTypes = [pType];
                                console.log(`🔀 Mapping 'tbd' (Tip ${currentSubTypeId}) -> Parent Bulundu, Hedef: ${pType}`);
                            } else {
                                // Parent yoksa mecburen self
                                potentialTargetTypes = [currentSubTypeId];
                                console.log(`🔀 Mapping 'tbd' (Tip ${currentSubTypeId}) -> Parent YOK, Hedef: Self`);
                            }
                        }
                    } 
                    else {
                        // Standart Sabit Kurallar
                        let mappedTypes = [];
                        if (Array.isArray(rawRule)) mappedTypes = rawRule.map(String);
                        else if (typeof rawRule === 'string') mappedTypes = [rawRule];
                        else if (rawRule.values && Array.isArray(rawRule.values)) mappedTypes = rawRule.values.map(v => v.stringValue || String(v));

                        if (mappedTypes.length > 0) {
                            potentialTargetTypes = mappedTypes;
                            console.log(`🔀 Mapping Uygulandı: ${JSON.stringify(potentialTargetTypes)}`);
                        }
                    }
                }
                // -------------------------------------------------------------
            }
        } catch (e) { console.warn("Mapping hatası:", e); }
    }

    // 3. Konu Başlığını ve ID'yi Kesinleştir
    if (potentialTargetTypes.length > 0 && recordId) {
        try {
            // ADIM A: Mevcut Zincirleri Ara
            for (const targetType of potentialTargetTypes) {
                // "1" gelirse "2" olarak ara (Güvenlik)
                const actualTarget = (targetType === "1") ? "2" : targetType;
                
                const threadKey = `${recordId}_${actualTarget}`;
                const threadDoc = await adminDb.collection("mailThreads").doc(threadKey).get();
                
                if (threadDoc.exists && threadDoc.data()?.rootSubject) {
                    parentTemplateSubject = threadDoc.data().rootSubject;
                    foundInThread = true;
                    
                    // Zincir bulundu!
                    namingTargetType = actualTarget; 
                    forcedThreadId = actualTarget;   
                    
                    console.log(`✅ Zincir BULUNDU! ID: ${namingTargetType} (Konu: "${parentTemplateSubject}")`);
                    break; 
                }
            }

            // ADIM B: Zincir Yoksa -> PARENT STANDARTLARINI UYGULA
            if (!foundInThread) {
                // Mapping listesinin başındaki tipi (Primary Parent - Örn: 2) hedef al.
                let targetTypeStr = potentialTargetTypes[0]; 
                
                // Normalizasyon (1 -> 2)
                if (targetTypeStr === "1") targetTypeStr = "2";

                if (targetTypeStr) {
                    console.log(`ℹ️ Zincir bulunamadı. Yeni zincir Parent (${targetTypeStr}) kimliğiyle başlatılıyor.`);
                    
                    // 1. ID'yi Parent Yap (Veritabanında zincir _2 olarak başlasın)
                    namingTargetType = targetTypeStr;
                    forcedThreadId = targetTypeStr;

                    // 2. Konuyu Parent'tan Al (mailSubject alanını kullan)
                    const parentRuleSnap = await adminDb.collection("template_rules")
                        .where("sourceType", "==", "task_completion_epats")
                        .where("taskType", "==", targetTypeStr)
                        .limit(1)
                        .get();

                    if (!parentRuleSnap.empty) {
                        const pRule = parentRuleSnap.docs[0].data();
                        if (pRule.templateId) {
                            const pTemplateSnap = await adminDb.collection("mail_templates").doc(pRule.templateId).get();
                            if (pTemplateSnap.exists) {
                                const ptData = pTemplateSnap.data();
                                
                                // [DÜZELTME] Sadece mailSubject alanını al.
                                // (ptData.subject yerine ptData.mailSubject kullanılıyor)
                                parentTemplateSubject = ptData.mailSubject;
                                
                                console.log(`🔗 Parent Konusu Seçildi (mailSubject): "${parentTemplateSubject}"`);
                            }
                        }
                    } else {
                        console.log(`⚠️ Parent (${targetTypeStr}) şablon kuralı bulunamadı.`);
                    }
                }
            }
            
        } catch (err) { console.error("❌ Konu belirleme hatası:", err); }
    }

    // ---------------------------------------------------------------------------------------
    // [GÜNCELLEME v16] ŞABLON SEÇİMİ (SELF / THIRD PARTY / DİNAMİK TİP 40)
    // ---------------------------------------------------------------------------------------
    if (template && client) {

      // --- A) Tip 40 için Özel Dinamik Mantık (Parent'a göre şekillenir) ---
      if (templateSearchType === "40" && parentTxnData && parentTxnData.type) {
          const pType = String(parentTxnData.type);
          const dynamicSubjectKey = `subject${pType}`;
          const dynamicBodyKey = `body${pType}`;
          
          if (template[dynamicSubjectKey] && template[dynamicBodyKey]) {
              console.log(`🔀 Dinamik Şablon (Tip 40): ${dynamicBodyKey} kullanılıyor.`);
              template.subject = template[dynamicSubjectKey];
              template.body = template[dynamicBodyKey];
              
              if (template[`mailSubject${pType}`]) {
                  template.mailSubject = template[`mailSubject${pType}`];
              }
          }
      }

      // 1. Varsayılan Değerler
      let rawBody = String(template.body || ""); // Ana body (Varsayılan)
      let detectedType = "unknown"; 

      console.log(`🔍 Şablon Analizi Başlıyor... RecordID: ${recordId}`);

      // --- B) PORTFÖY TİPİ BELİRLEME (SELF / THIRD_PARTY) ---
      // Öncelik: Veritabanı Kaydı
      const dbType = ipRecordData?.recordOwnerType ? String(ipRecordData.recordOwnerType).trim().toLowerCase() : null;

      if (dbType === 'third_party') {
          detectedType = 'third_party';
      } 
      else if (dbType === 'self') {
          detectedType = 'self';
      } 
      else {
          // DB'de tip yoksa -> Otomatik Tespit (Fallback)
          // Müvekkil (client) ile Başvuru Sahibi (applicants) eşleşmesine bak
          const apps = ipRecordData?.applicants || [];
          const isClientApplicant = (client && apps.length > 0) 
              ? apps.some(app => String(app.id || app.personId) === String(client.id)) 
              : false;
          
          // Eşleşme varsa 'self', yoksa 'third_party' (rakip) kabul et
          detectedType = isClientApplicant ? 'self' : 'third_party'; 
          console.log(`🧩 Otomatik Tespit: DB Type '${dbType}' geçersiz. Müvekkil Eşleşmesi: ${isClientApplicant} -> Algılanan: ${detectedType}`);
      }

      console.log(`📊 FINAL OWNER TYPE: ${detectedType}`);

      // --- C) İÇERİK SEÇİMİ (BODY1 vs BODY2) ---
      if (detectedType === 'third_party') {
          // Karşı Taraf Dosyası -> body2 kullan (Varsa)
          if (template.body2 && template.body2.trim() !== "") {
              rawBody = String(template.body2);
              console.log("✅ SEÇİLEN ŞABLON: 'body2' (Third Party)");
          } else {
              console.log("ℹ️ SEÇİLEN ŞABLON: 'body' (Varsayılan) -> Çünkü 'body2' alanı boş.");
          }
      }
      else if (detectedType === 'self') {
          // Kendi Dosyamız -> body1 kullan (Varsa)
          if (template.body1 && template.body1.trim() !== "") {
              rawBody = String(template.body1);
              console.log("✅ SEÇİLEN ŞABLON: 'body1' (Self)");
          } else {
              console.log("ℹ️ SEÇİLEN ŞABLON: 'body' (Varsayılan) -> Çünkü 'body1' alanı boş.");
          }
      }
      else {
           console.log("ℹ️ SEÇİLEN ŞABLON: 'body' (Varsayılan) -> Tip belirlenemedi.");
      }

      // --- D) Konu Başlığı ve İçerik İşleme (Mevcut Mantık) ---
      let childSubjectRaw = String(template.subject || "");
      subject = childSubjectRaw;
      if (parentTemplateSubject) {
          subject = String(parentTemplateSubject);
      }

      // Parametreleri Hazırla
      const parameters = {
        ...client, ...after, ...ipRecordData, ...fetchedTaskData, 
        muvekkil_adi: "Değerli Müvekkilimiz",
        proje_adi: enrichedData.markName,
        epats_evrak_no: after.turkpatentEvrakNo || after.evrakNo || "-",
        epats_konu: after.konu || "-",
        islem_turu_adi: finalIslemTanimlamasi, 
        teblig_tarihi: enrichedData.tebligTarihiFormatted,
        resmi_son_cevap_tarihi: enrichedData.deadlineFormatted,
        son_odeme_tarihi: enrichedData.deadlineFormatted,
        itiraz_sahibi: enrichedData.itirazSahibi, 
        dava_son_tarihi: davaSonTarihi,
        dava_son_tarihi_display_style: (davaSonTarihi && davaSonTarihi !== "-") ? "block" : "none",
        karar_sonucu_baslik: decisionAnalysis.resultText,
        karar_durumu_metni: decisionAnalysis.statusText,
        karar_durumu_renk: decisionAnalysis.statusColor,
        aksiyon_kutusu_bg: decisionAnalysis.boxColor,
        aksiyon_kutusu_border: decisionAnalysis.boxBorder,
        karar_ozeti_detay: decisionAnalysis.summaryText + (decisionAnalysis.isLawsuitRequired ? "<br><br>Bu karara karşı belirtilen tarihe kadar <strong>YİDK Kararının İptali davası</strong> açma hakkınız bulunmaktadır." : "<br><br>Şu an için tarafınızca yapılması gereken bir işlem bulunmamaktadır."),
        applicationNo: ipRecordData?.applicationNumber || ipRecordData?.applicationNo || "-",
        markName: enrichedData.markName,
        markImageUrl: enrichedData.markImageUrl,
        applicantNames: enrichedData.applicantNames,
        classNumbers: enrichedData.classNumbers,
        applicationDate: enrichedData.applicationDate,
        basvuru_no: ipRecordData?.applicationNumber || ipRecordData?.applicationNo || "-"
      };

      // Değişkenleri Yerleştir
      const replaceVars = (str) => str.replace(/{{\s*([\w.]+)\s*}}/g, (_, k) => parameters[k] ?? "");

      subject = replaceVars(subject);
      const childSubjectResolved = replaceVars(childSubjectRaw);
      let resolvedBody = replaceVars(rawBody);

      // Konu Kutusu Enjeksiyonu
      if (parentTemplateSubject && subject.trim() !== childSubjectResolved.trim()) {
          const innerSubjectHtml = `
            <div style="background-color: #f8f9fa; border-left: 4px solid #1a73e8; padding: 15px; margin: 0 0 20px 0; font-family: Arial, sans-serif; color: #333; font-size: 14px;">
                <strong style="color: #1a73e8;">KONU:</strong> ${childSubjectResolved}
            </div>
          `;

          if (resolvedBody.toLowerCase().includes("<body")) {
              body = resolvedBody.replace(/<body[^>]*>/i, (match) => {
                  return match + innerSubjectHtml;
              });
              console.log("✅ Kutu BODY etiketinin içine enjekte edildi.");
          } else {
              body = innerSubjectHtml + resolvedBody;
              console.log("✅ Kutu içeriğin en başına eklendi.");
          }
      } else {
          body = resolvedBody;
      }
      
      // ID Düzeltme (Son Çare)
      if (typeof forcedThreadId !== 'undefined' && forcedThreadId) {
          namingTargetType = forcedThreadId;
      }
    }

    const missingFields = [];
    if (!client) missingFields.push("client");
    if (!template) missingFields.push("template"); 
    if (toRecipients.length === 0 && ccRecipients.length === 0) missingFields.push("recipients");

    // Hassas Task Type'ları (Tetiklenen İşlerin ID'leri)
    const SENSITIVE_TASK_TYPES = ['7', '19', '49', '54'];

    // Tetiklenen task'ın type'ını kontrol et
    let triggeringTaskType = null;
    if (fetchedTaskData?.taskType) {
        triggeringTaskType = String(fetchedTaskData.taskType);
    }

    const isSensitiveTask = triggeringTaskType ? SENSITIVE_TASK_TYPES.includes(triggeringTaskType) : false;

    // 🔥 ÇÖZÜM: Mail statüsü belirlenirken SADECE işin hassas olması yetmez, 
    // müvekkilin "Değerlendirme Gerekli" (isEvaluationRequired) toggle'ı da AÇIK olmalıdır!
    const finalStatus = missingFields.length > 0
      ? "missing_info"
      : ((isSensitiveTask && isEvaluationRequired) ? "evaluation_pending" : "awaiting_client_approval");


    console.log(`📊 Durum Belirleme:`, {
        missingFields,
        isEvaluationRequired,
        isSensitiveTask,
        triggeringTaskType,
        finalStatus
    });

   
    // 1. URL Belirleme: Yeni sistem 'fileUrl', eski sistem 'downloadURL' kullanıyor. İkisini de kontrol et.
    const fileUrlToUse = after.fileUrl || after.downloadURL || null;

    // 2. Dosya Adı Belirleme: 'fileName' yoksa 'name', o da yoksa varsayılan isim.
    const fileNameToUse = after.fileName || after.name || "epats_document.pdf";

    const epatsAttachment = {
      storagePath: after.storagePath || null,
      downloadURL: fileUrlToUse, // Artık doğru URL buraya gelecek
      fileName: fileNameToUse,
    };


    // --- EKLERİ HAZIRLA (GÜNCELLENDİ) ---
    const taskAttachments = [];

    // 1. Görev/Doküman üzerindeki manuel ekler (Varsa)
    if (after.documents && Array.isArray(after.documents)) {
        after.documents.forEach(doc => {
            taskAttachments.push({
                name: doc.name || "ek_belge.pdf",
                url: doc.url || doc.downloadURL,
                storagePath: doc.storagePath || null, 
                type: 'application/pdf'
            });
        });
    }

    // 2. İtiraz Dilekçesi (Varsa ekle)
    if (oppositionFileUrl) {
        taskAttachments.push({
            name: "Itiraz_Dilekcesi.pdf",
            url: oppositionFileUrl,
            type: 'application/pdf'
        });
    }

    // 3. Karşı ePATS Dilekçesi (Varsa ekle - YENİ)
    if (oppositionEpatsFileUrl) {
        taskAttachments.push({
            name: "Karsi_Epats_Dilekcesi.pdf",
            url: oppositionEpatsFileUrl,
            type: 'application/pdf'
        });
    }

    // UI listesi için (Bildirim ekranında görünmesi için)
    const allUiFiles = [];
    if (fileUrlToUse) { // fileUrlToUse değişkeni yukarıda tanımlı
        allUiFiles.push({
            url: fileUrlToUse,
            name: fileNameToUse,
            storagePath: after.storagePath || null,
            type: 'application/pdf'
        });
    }
    taskAttachments.forEach(d => allUiFiles.push(d));

    const notificationData = {
      recipientTo: toRecipients || [],
      recipientCc: ccRecipients || [],
      toList: toRecipients || [], 
      ccList: ccRecipients || [],
      clientId: after.clientId || (applicants[0]?.id || null),
      subject: subject || "",
      body: body || "",
      status: finalStatus, 
      missingFields: missingFields || [],
      sourceDocumentId: docId || null,
      notificationType: notificationType || "marka",
      taskType: templateSearchType || null,
      dynamicParentContext: namingTargetType, // Hesaplanan hedef (Örn: "3" olarak kaydedilecek)
      taskOwner: taskOwnerIds || [], 
      applicantName: (client && (client.name || client.companyName)) || null,
      epatsAttachment, 
      taskAttachments: taskAttachments, // <-- Tüm ekler burada
      files: allUiFiles, // UI'da görünmesi için dosyalar listesi
      assignedTo_uid: selcanUserId || null,
      assignedTo_email: selcanUserEmail || null,
      dependentTaskId: (fetchedTxnData && fetchedTxnData.triggeringTaskId) || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const notificationRef = await adminDb.collection("mail_notifications").add(notificationData);

    const mailNotificationId = notificationRef.id;
    console.log(`✅ Mail bildirimi oluşturuldu: ${mailNotificationId}`);

    if (recordId && associatedTransactionId) {
        try {
            await admin.firestore()
                .collection("ipRecords")
                .doc(recordId)
                .collection("transactions")
                .doc(associatedTransactionId)
                .update({
                    mailNotificationId: mailNotificationId // 🔗 Mail ve Transaction bağlandı
                });
            console.log(`🔗 Transaction ${associatedTransactionId} mail ID ile güncellendi.`);
        } catch (error) {
            console.error("❌ Transaction güncelleme hatası:", error);
        }
    }

    console.log(`🔍 ID 66 Kontrol:`, {
        isEvaluationRequired,
        isSensitiveTask,
        triggeringTaskType,
        finalStatus,
        willCreateTask: (isEvaluationRequired && isSensitiveTask && finalStatus === "evaluation_pending")
    });

    if (isEvaluationRequired && isSensitiveTask && finalStatus === "evaluation_pending") {
        console.log(`🚀 ID 66 görevi oluşturuluyor...`);
        
        // 1. Task ID Sayacını (Counter) Artır ve Yeni ID'yi Al
        const countersRef = adminDb.collection('counters').doc('tasks');
        const newTaskId = await adminDb.runTransaction(async (tx) => {
            const snap = await tx.get(countersRef);
            const last = snap.exists ? Number(snap.data()?.lastId || 0) : 0;
            const next = last + 1;
            // Sayacı güncelle
            tx.set(countersRef, { lastId: next }, { merge: true });
            return String(next);
        });

        // 2. Atama Kuralını Çek
        const assignmentSnap = await adminDb.collection("taskAssignments").doc("66").get();
        const assignmentData = assignmentSnap.exists ? assignmentSnap.data() : {};
        const assignedUid = (assignmentData.assigneeIds && assignmentData.assigneeIds[0]) || null;

        if (assignedUid) {
            const userSnap = await adminDb.collection("users").doc(assignedUid).get();
            const assignedEmail = userSnap.exists ? userSnap.data().email : "";

            // --- [YENİ] ID 66 İÇİN AKILLI TARİH HESAPLAMA ---
            let task66DueDate = null;
            
            // rawTeblig: Tebliğ Tarihi (Fonksiyonda zaten tanımlı)
            // calculatedDeadline: Resmi Son Tarih (Fonksiyonda zaten tanımlı)
            
            if (rawTeblig) {
                try {
                    // 1. Tebliğ Tarihini Al ve +10 Gün Ekle (Varsayılan Hedef)
                    let baseDate = null;
                    if (typeof rawTeblig.toDate === 'function') baseDate = rawTeblig.toDate();
                    else baseDate = new Date(rawTeblig);

                    let targetDate = new Date(baseDate);
                    targetDate.setDate(targetDate.getDate() + 10); // Tebliğ + 10

                    // 2. Resmi Son Tarihi Kontrol Et
                    let officialLimit = null;
                    // calculatedDeadline yoksa rawDeadline'a bak (Data recovery)
                    const refDeadline = calculatedDeadline || rawDeadline; 
                    
                    if (refDeadline) {
                        if (typeof refDeadline.toDate === 'function') officialLimit = refDeadline.toDate();
                        else officialLimit = new Date(refDeadline);
                    }

                    // 3. Karşılaştırma ve Güvenlik Payı (Safety Margin)
                    if (officialLimit && !isNaN(officialLimit.getTime())) {
                        
                        // Eğer (Tebliğ + 10) tarihi, Resmi Son Tarih'i geçiyorsa (veya eşitse)
                        if (targetDate >= officialLimit) {
                            console.log(`⚠️ Uyarı: (Tebliğ + 10 gün) resmi süreyi aşıyor! Güvenlik protokolü devrede.`);
                            
                            // Tarihi (Resmi Son Tarih - 5 Gün) olarak ayarla
                            let safeDate = new Date(officialLimit);
                            safeDate.setDate(safeDate.getDate() - 5);
                            
                            targetDate = safeDate;
                        }
                    }

                    // Sonuç Geçerli mi?
                    if (!isNaN(targetDate.getTime())) {
                        task66DueDate = admin.firestore.Timestamp.fromDate(targetDate);
                        console.log(`📅 Task 66 Son Tarihi Ayarlandı: ${targetDate.toLocaleDateString('tr-TR')}`);
                    }

                } catch (err) {
                    console.warn("⚠️ Task 66 akıllı tarih hesaplama hatası:", err);
                }
            }
            // -----------------------------------------------------------

            // 4. Görevi Kaydet
            await adminDb.collection("tasks").doc(newTaskId).set({
                id: newTaskId,
                taskType: "66",
                title: `Değerlendirme: ${subject}`,
                description: `Müvekkil hassas gruptadır. Taslağı düzenleyip onaylayın.`,
                status: "open",
                mail_notification_id: notificationRef.id, 
                relatedIpRecordId: recordId || null,
                relatedIpRecordTitle: enrichedData.markName || "-",
                iprecordApplicationNo: ipRecordData?.applicationNumber || ipRecordData?.applicationNo || "-",
                iprecordTitle: enrichedData.markName || "-",
                iprecordApplicantName: enrichedData.applicantNames || "-",
                assignedTo_uid: assignedUid,
                assignedTo_email: assignedEmail,
                priority: "high",

                // --- HESAPLANAN TARİHLER ---
                officialDueDate: task66DueDate, 
                dueDate: task66DueDate,         
                // ---------------------------

                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                history: [{
                    action: 'Hassas müvekkil nedeniyle sayısal ID ile değerlendirme işi oluşturuldu.',
                    timestamp: new Date().toISOString(),
                    userEmail: 'system'
                }]
            });
            console.log(`✅ ID 66 Görevi sayısal ID (${newTaskId}) ile oluşturuldu.`);
        } else {
            console.log(`⚠️ ID 66 görevi için atama bulunamadı! assignedUid: ${assignedUid}`);
        }
    } else {
        console.log(`ℹ️ ID 66 görevi oluşturulmadı (koşullar sağlanmadı)`);
    }
    
    console.log(`✅ Mail bildirimi oluşturuldu (${finalStatus}):`, notificationData.subject);
    return null;
  }
);

// functions/index.js

export const createUniversalNotificationOnTaskCompleteV2 = onDocumentUpdated(
  {
    document: "tasks/{taskId}",
    region: "europe-west1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return null;

    const before = change.before.data() || {};
    const after  = change.after.data() || {};
    const taskId = event.params.taskId;

    if (String(after.taskType) === "66") {
        console.log(`ℹ️ Task ${taskId} (Tip 66 - Değerlendirme) tamamlandı ancak bildirim oluşturulmadı.`);
        return null;
    }

    if (String(after.taskType) === "53") {
        console.log(`ℹ️ Task ${taskId} (Tip 53 - Tahakkuk) tamamlandı. Müvekkil bildirimi oluşturulmuyor.`);
        return null; 
    }

    // Sadece "Completed" statüsüne geçişte çalış
    const becameCompleted = before.status !== "completed" && after.status === "completed";
    
    // EPATS Belge Kontrolü
    const epatsDoc = after?.details?.epatsDocument || null;
    
    if (!becameCompleted) return null;

    const dedupe = (arr) => Array.from(new Set((arr || []).filter(Boolean).map((x) => String(x).trim())));
    const categoryKey = "marka"; // Varsayılan

    // --- ALICI BELİRLEME YARDIMCISI ---
    const findRecipientsFromPersonsRelated = async (personIds) => {
      const to = [], cc = [];
      if (!Array.isArray(personIds) || personIds.length === 0) return { to, cc };
      
      const chunks = [];
      for (let i = 0; i < personIds.length; i += 10) chunks.push(personIds.slice(i, i + 10));
      
      for (const chunk of chunks) {
        const prSnap = await adminDb.collection("personsRelated").where("personId", "in", chunk).get();
        prSnap.forEach((d) => {
          const pr = d.data();
          const email = (pr.email || "").trim();
          const isResp = pr?.responsible?.[categoryKey] === true;
          const n = pr?.notify?.[categoryKey] || {};
          if (email && isResp) {
            if (n?.to === true) to.push(email);
            if (n?.cc === true) cc.push(email);
          }
        });
      }
      return { to: dedupe(to), cc: dedupe(cc) };
    };

    const getRecipientsByApplicantIdsLocal = async (applicants) => {
      const ids = (Array.isArray(applicants) ? applicants : []).map(a => a?.id).filter(Boolean);
      return await findRecipientsFromPersonsRelated(ids);
    };

    // IP Kaydını Çek
    let ipRecord = null;
    if (after.relatedIpRecordId) {
      try {
        const ipSnap = await adminDb.collection("ipRecords").doc(after.relatedIpRecordId).get();
        if (ipSnap.exists) ipRecord = ipSnap.data();
      } catch (e) {
        console.warn("IP kaydı okunurken hata:", e?.message || e);
      }
    }

    // --- İTİRAZ SAHİBİ VERİSİNİ PARENT TRANSACTION'DAN ÇEK ---
    let oppositionOwnerName = "-";

    try {
        const relatedTxId = after.relatedTransactionId || after.transactionId;
        if (after.relatedIpRecordId && relatedTxId) {
            // 1. Mevcut (Child) Transaction'ı çekerek parentId'ye ulaşalım
            const txSnap = await adminDb.collection("ipRecords")
                .doc(after.relatedIpRecordId)
                .collection("transactions")
                .doc(relatedTxId)
                .get();
            
            if (txSnap.exists) {
                const txData = txSnap.data();
                
                // 2. parentId varsa, üst işleme gidip oppositionOwner bilgisini alalım
                if (txData.parentId) {
                    const parentSnap = await adminDb.collection("ipRecords")
                        .doc(after.relatedIpRecordId)
                        .collection("transactions")
                        .doc(txData.parentId)
                        .get();
                    
                    if (parentSnap.exists) {
                        oppositionOwnerName = parentSnap.data().oppositionOwner || "-";
                        console.log(`✅ İtiraz Sahibi üst işlemden çekildi: ${oppositionOwnerName}`);
                    }
                }
            }
        }
    } catch (e) {
        console.warn("⚠️ İtiraz sahibi bilgisi hiyerarşiden çekilemedi:", e.message);
    }

    // --- DATA HAZIRLIĞI ---
    let enrichedData = {
        applicantNames: "-",
        classNumbers: "-",
        applicationDate: "-",
        markImageUrl: ""
    };

    let nameSourceFound = false;

    // 1. ÖNCELİK: Task Owner
    let rawOwnerForName = after.taskOwner;
    if (typeof rawOwnerForName === 'string') rawOwnerForName = [rawOwnerForName];
    const taskOwnerIdsForName = Array.isArray(rawOwnerForName) ? rawOwnerForName.filter(Boolean) : [];
    
    if (taskOwnerIdsForName.length > 0) {
        try {
            const names = [];
            for (const uid of taskOwnerIdsForName) {
                const pDoc = await adminDb.collection("persons").doc(uid).get();
                if (pDoc.exists) {
                    const pd = pDoc.data();
                    names.push(pd.name || pd.companyName || "-");
                }
            }
            if (names.length > 0) {
                enrichedData.applicantNames = names.join(", ");
                nameSourceFound = true;
            }
        } catch (e) { console.error("taskOwner name fetch error:", e); }
    }

    // 2. ÖNCELİK: Task Details
    if (!nameSourceFound) {
        const tDetails = after.details || {};
        let targetParties = [];
        if (tDetails.relatedParty) targetParties.push(tDetails.relatedParty);
        else if (Array.isArray(tDetails.relatedParties)) targetParties = tDetails.relatedParties;

        if (targetParties.length > 0) {
            try {
                const names = [];
                for (const p of targetParties) {
                    if (p.id) {
                        const pDoc = await adminDb.collection("persons").doc(p.id).get();
                        if (pDoc.exists) {
                            names.push(pDoc.data().name || pDoc.data().companyName || "-");
                        } else if (p.name) names.push(p.name);
                    } else if (p.name) names.push(p.name);
                }
                if (names.length > 0) {
                    enrichedData.applicantNames = names.join(", ");
                    nameSourceFound = true;
                }
            } catch (e) { console.error("Related party fetch error:", e); }
        }
    }

    // IP Kaydı Verilerini İşle
    if (ipRecord) {
        const clean = (val) => (val ? String(val).trim() : "");
        
        enrichedData.markImageUrl = 
            clean(ipRecord.brandImageUrl) || 
            clean(ipRecord.trademarkImage) || 
            clean(ipRecord.publicImageUrl) || 
            clean(ipRecord.imageUrl) ||       
            clean(ipRecord.imageSignedUrl) || 
            "";

        if (!nameSourceFound) {
            try {
                const rawApplicants = ipRecord.applicants || [];
                const namesList = [];
                for (const app of rawApplicants) {
                    if (app.id) {
                        const pDoc = await adminDb.collection("persons").doc(app.id).get();
                        if (pDoc.exists) namesList.push(pDoc.data().name || pDoc.data().companyName || "-");
                    }
                }
                if (namesList.length > 0) enrichedData.applicantNames = namesList.join(", ");
            } catch (e) { }
        }

        if (ipRecord.goodsAndServicesByClass && Array.isArray(ipRecord.goodsAndServicesByClass)) {
            enrichedData.classNumbers = ipRecord.goodsAndServicesByClass.map(item => item.classNo).filter(Boolean).join(", ");
        }
        
        const formatDate = (val) => {
            if (!val) return "-";
            const date = (val.toDate) ? val.toDate() : new Date(val);
            return isNaN(date.getTime()) ? "-" : date.toLocaleDateString("tr-TR");
        };
        enrichedData.applicationDate = formatDate(ipRecord.applicationDate);
    }

    // --- ŞABLON SEÇİMİ ---
    let template = null, templateId = null, hasTemplate = false;
    let parentTemplateSubject = null; // YENİ: Ata Konu için değişken

    try {
      const currentTaskType = String(after.taskType || "");
      if (currentTaskType) {
        
        // 1. Kendi Şablonunu Bul
        const rulesSnap = await adminDb.collection("template_rules")
          .where("sourceType", "==", "task_completion_epats")
          .where("taskType", "==", currentTaskType)
          .limit(1)
          .get();

        if (!rulesSnap.empty) {
          const rule = rulesSnap.docs[0].data();
          templateId = rule?.templateId || null;
          if (templateId) {
            const tSnap = await adminDb.collection("mail_templates").doc(templateId).get();
            if (tSnap.exists) {
              template = tSnap.data();
              hasTemplate = true;
            }
          }
        }

        // 2. [YENİ] PARENT ŞABLON & KONU ARAMA (Fallback Subject)
        // Eğer transactionTypeMatch tablosunda bir eşleşme varsa, parent konusunu bulmaya çalış.
        const matchDoc = await adminDb.collection('mailThreads').doc('transactionTypeMatch').get();
        if (matchDoc.exists) {
            const mapping = matchDoc.data();
            // Mapping değeri string ("2") veya array (["19", "2"]) olabilir
            let parentTypes = mapping[currentTaskType];
            
            if (parentTypes) {
                if (!Array.isArray(parentTypes)) parentTypes = [parentTypes];
                
                // İlk uygun parent için şablon ara (Örn: "2" -> Başvuru)
                // Genelde en sondaki (en kök) parent tercih edilir ama burada ilkine bakıyoruz.
                // Eğer ["19", "2"] ise, önce 19'a bakar.
                for (const pType of parentTypes) {
                    const pRuleSnap = await adminDb.collection("template_rules")
                        .where("sourceType", "==", "task_completion_epats") // veya uygun source type
                        .where("taskType", "==", String(pType))
                        .limit(1)
                        .get();
                    
                    if (!pRuleSnap.empty) {
                        const pTmplId = pRuleSnap.docs[0].data().templateId;
                        if (pTmplId) {
                            const pTmplSnap = await adminDb.collection("mail_templates").doc(pTmplId).get();
                            if (pTmplSnap.exists) {
                                // Parent konusunu yakaladık!
                                parentTemplateSubject = pTmplSnap.data().mailSubject || pTmplSnap.data().subject;
                                console.log(`🔗 Parent Konu Bulundu (Tip: ${pType}): ${parentTemplateSubject}`);
                                break; // İlk bulduğumuzu alıp çıkıyoruz
                            }
                        }
                    }
                }
            }
        }

      }
    } catch (e) { console.warn("Template kuralı aranırken hata:", e); }

    // --- ALICILARI BELİRLE ---
    let rawOwner = after.taskOwner;
    if (typeof rawOwner === 'string') rawOwner = [rawOwner];
    const ownerIds = Array.isArray(rawOwner) ? rawOwner.filter(Boolean) : [];

    let toRecipients = [], ccRecipients = [], usedSource = null;

    if (ownerIds.length > 0) {
      usedSource = "taskOwner";
      const r = await findRecipientsFromPersonsRelated(ownerIds);
      toRecipients = r.to;
      ccRecipients = r.cc;
    } else {
      usedSource = "applicants_fallback";
      const r = await getRecipientsByApplicantIdsLocal(ipRecord?.applicants || []);
      toRecipients = r.to;
      ccRecipients = r.cc;
    }

    // CC Listesini Genişlet
    let txTypeForCc = null;
    try {
      const relatedIpId = after.relatedIpRecordId || null;
      const relatedTxId = after.relatedTransactionId || after.transactionId || null;
      if (relatedIpId && relatedTxId) {
        const txSnap = await adminDb.collection("ipRecords").doc(relatedIpId).collection("transactions").doc(relatedTxId).get();
        if (txSnap.exists) txTypeForCc = txSnap.data()?.type ?? null;
      }
      if (txTypeForCc == null && after.taskType != null) txTypeForCc = after.taskType;
      
      if (txTypeForCc != null) {
        const extra = await getCcFromEvrekaListByTransactionType(txTypeForCc);
        ccRecipients = dedupe([...(ccRecipients || []), ...(extra || [])]);
      }
    } catch (e) { console.warn("CC listesi genişletilirken hata:", e); }

    // --- İÇERİK OLUŞTURMA ---
    let subject = "", body = "";
    if (hasTemplate) {
      // 1. Konu Seçimi: Varsa Parent, Yoksa Kendi Konusu
      let rawEmailSubject = "";
      if (parentTemplateSubject) {
          rawEmailSubject = String(parentTemplateSubject);
      } else {
          rawEmailSubject = String(template.mailSubject || template.subject || "");
      }

      let rawInnerSubject = String(template.subject || "");

      // 1. Varsayılanı Ayarla
      let rawBody = String(template.body || "");
      let detectedType = "unknown";

      // ---------------------------------------------------------
      // PORTFÖY TİPİ VE ŞABLON SEÇİMİ (CRASH FIX + normalize)
      // ---------------------------------------------------------
      console.log(`🔍 Şablon Analizi Başlıyor... RecordID: ${after.relatedIpRecordId || 'Bilinmiyor'}`);

      const normalizeOwnerType = (v) => {
        const s = String(v || "").trim().toLowerCase();
        if (!s) return null;
        const n = s.replace(/[\s-]+/g, "_"); // "third party" -> "third_party"
        if (["self", "own", "portfolio", "my", "muvekkil", "müvekkil"].includes(n)) return "self";
        if ([
          "third_party", "thirdparty", "third", "opponent", "rakip",
          "karsi_taraf", "karşı_taraf", "karsitaraf", "karşıtaraf"
        ].includes(n)) return "third_party";
        return n;
      };

      // ✅ Öncelik: task/doküman üzerindeki type -> ipRecord üzerindeki type -> applicants fallback
      const docType = normalizeOwnerType(
        after.recordOwnerType || after.ownerType || after.portfolioType || null
      );

      const dbType = normalizeOwnerType(
        ipRecord?.recordOwnerType || ipRecord?.ownerType || ipRecord?.portfolioType || null
      );

      detectedType = docType || dbType || "unknown";

      // applicants fallback (client değişkeni yoksa bile güvenli)
      if (detectedType !== "self" && detectedType !== "third_party") {
        const apps = Array.isArray(ipRecord?.applicants) ? ipRecord.applicants : [];
        const clientId = String(after.clientId || ipRecord?.clientId || "").trim();

        const isClientApplicant =
          clientId && apps.length > 0
            ? apps.some(app => String(app?.id || app?.personId || "").trim() === clientId)
            : false;

        detectedType = isClientApplicant ? "self" : "third_party";
        console.log(`🧩 Fallback ownerType: applicants kontrolü -> ${detectedType}`);
      }

      console.log("🧭 FINAL OWNER TYPE", {
        relatedIpRecordId: after.relatedIpRecordId || null,
        docType,
        dbType,
        detectedType,
      });

      // B) İÇERİK SEÇİMİ (tmpl_50_document için body1/body2)
      if (templateId === "tmpl_50_document") {
        if (detectedType === "third_party") {
          if (template.body2 && String(template.body2).trim() !== "") {
            rawBody = String(template.body2);
            console.log("✅ SEÇİLEN ŞABLON: 'body2' (Third Party)");
          } else {
            console.log("ℹ️ SEÇİLEN ŞABLON: 'body' (Varsayılan) -> body2 boş.");
          }
        } else if (detectedType === "self") {
          if (template.body1 && String(template.body1).trim() !== "") {
            rawBody = String(template.body1);
            console.log("✅ SEÇİLEN ŞABLON: 'body1' (Self)");
          } else {
            console.log("ℹ️ SEÇİLEN ŞABLON: 'body' (Varsayılan) -> body1 boş.");
          }
        } else {
          console.log("ℹ️ SEÇİLEN ŞABLON: 'body' (Varsayılan) -> Tip belirlenemedi.");
        }
      } else {
        console.log(`ℹ️ Template ${templateId} için varsayılan body kullanılıyor.`);
      }

      const ipTitle = ipRecord?.title || after.relatedIpRecordTitle || "Dosya";

      const formatTrDate = (val) => {
        if (!val) return new Date().toLocaleDateString("tr-TR");
        const d = (val && val.toDate) ? val.toDate() : new Date(val);
        return isNaN(d.getTime()) ? new Date().toLocaleDateString("tr-TR") : d.toLocaleDateString("tr-TR");
      };
      const formatDeadline = (val) => {
        if (!val) return "-";
        const d = (val && val.toDate) ? val.toDate() : new Date(val);
        return isNaN(d.getTime()) ? "-" : d.toLocaleDateString("tr-TR");
      };

      const transactionDateStr = formatTrDate(epatsDoc?.documentDate || new Date());

      const parameters = {
        muvekkil_adi: "Değerli Müvekkilimiz",
        proje_adi: ipTitle,
        relatedIpRecordTitle: ipTitle,
        is_basligi: after.title || "",
        epats_evrak_no: epatsDoc?.turkpatentEvrakNo || epatsDoc?.evrakNo || "",
        applicationNo: ipRecord?.applicationNumber || ipRecord?.applicationNo || "-",
        markName: ipRecord?.title || ipRecord?.markName || "-",
        markImageUrl: enrichedData.markImageUrl,
        applicantNames: enrichedData.applicantNames,
        classNumbers: enrichedData.classNumbers,
        applicationDate: enrichedData.applicationDate,
        transactionDate: transactionDateStr,
        itiraz_sahibi: oppositionOwnerName,
        basvuru_no: ipRecord?.applicationNumber || ipRecord?.applicationNo || "-",
        
        // [GÜNCELLEME] Hata veren değişken kaldırıldı, sabit değer atandı.
        son_odeme_tarihi: "-" 
      };

      const replaceVars = (str) =>
        String(str || "").replace(/{{\s*([\w.]+)\s*}}/g, (_, k) => parameters[k] ?? "");

      subject = replaceVars(rawEmailSubject);
      const innerSubjectResolved = replaceVars(rawInnerSubject);
      let resolvedBody = replaceVars(rawBody);

      if (innerSubjectResolved) {
        const innerSubjectHtml = `
          <div style="background-color: #f8f9fa; border-left: 4px solid #1a73e8; padding: 15px; margin: 0 0 20px 0; font-family: Arial, sans-serif; color: #333; font-size: 14px;">
            <strong style="color: #1a73e8;">KONU:</strong> ${innerSubjectResolved}
          </div>
        `;
        if (resolvedBody.toLowerCase().includes("<body")) {
          body = resolvedBody.replace(/<body[^>]*>/i, (match) => match + innerSubjectHtml);
        } else {
          body = innerSubjectHtml + resolvedBody;
        }
      } else {
        body = resolvedBody;
      }
    }

    // Statü Belirleme
    const coreMissing = [];
    if ((toRecipients.length + ccRecipients.length) === 0) coreMissing.push("recipients");
    if (!hasTemplate) coreMissing.push("mailTemplate");
    const finalStatus = coreMissing.length ? "missing_info" : "awaiting_client_approval";

    // URL kontrolü
    const validUrl = epatsDoc?.url || epatsDoc?.downloadURL || null;

    const epatsAttachment = {
      storagePath: epatsDoc?.storagePath || null,
      downloadURL: validUrl, 
      fileName:    epatsDoc?.name || "epats.pdf",
    };

    // Task üzerindeki diğer belgeleri topla
    const taskAttachments = [];
    if (after.documents && Array.isArray(after.documents)) {
        after.documents.forEach(doc => {
            taskAttachments.push({
                name: doc.name || "ek_belge.pdf",
                url: doc.url || doc.downloadURL,
                // 🔥 DÜZELTME: undefined yerine null gönderiyoruz
                storagePath: doc.storagePath || null, 
                type: 'application/pdf'
            });
        });
    }

    // UI listesi (EPATS + Diğerleri)
    const allUiFiles = [];
    if (validUrl) {
        allUiFiles.push({
            url: validUrl,
            name: epatsAttachment.fileName,
            storagePath: epatsAttachment.storagePath,
            type: 'application/pdf'
        });
    }
    taskAttachments.forEach(d => allUiFiles.push(d));

    const notificationDoc = {
      toList: dedupe(toRecipients),
      ccList: dedupe(ccRecipients),
      subject,
      body,
      status: finalStatus,
      missingFields: coreMissing,
      mode: "draft",
      isDraft: true,
      assignedTo_uid: selcanUserId, 
      assignedTo_email: selcanUserEmail,
      relatedIpRecordId: after.relatedIpRecordId || null,
      associatedTaskId:  taskId,
      associatedTransactionId: after.relatedTransactionId || after.transactionId || null,
      templateId: templateId || null,
      notificationType: "marka",
      taskType: after.taskType || null, 
      source: usedSource,
      
      epatsAttachment,
      taskAttachments, 

      documentUrl: validUrl, 
      documentName: epatsAttachment.fileName,
      documentSource: "EPATS (Manuel)", 
      
      files: allUiFiles, 

      taskOwner: ownerIds,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await adminDb.collection("mail_notifications").add(notificationDoc);
    console.log(`Bildirim '${finalStatus}' olarak oluşturuldu. TaskType: ${after.taskType}`);

    return null;
  }
);

// =========================================================
//              STORAGE TRIGGER FONKSİYONLARI (v2)
// =========================================================

// Trademark Bulletin Upload Processing (v2 Storage Trigger)
// Debug edilmiş processTrademarkBulletinUploadV2 fonksiyonu
export const processTrademarkBulletinUploadV3 = onObjectFinalized(
  {
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "2GiB" // Bellek limiti artırıldı
  },
  async (event) => {
    const filePath = event.data.name || "";
    const fileName = path.basename(filePath);

    // Sadece bulletins/ altındaki ZIP dosyalarını işle
    if (!filePath.startsWith("bulletins/") || !fileName.toLowerCase().endsWith(".zip")) {
      return null; // log atma
    }

    console.log("🔥 Trademark Bulletin Upload V3 başladı:", filePath);

    const bucket = admin.storage().bucket();
    const tempFilePath = path.join(os.tmpdir(), fileName);
    const extractDir = path.join(os.tmpdir(), `extract_${Date.now()}`);

    try {
      // ZIP indir
      await downloadWithStream(bucket.file(filePath), tempFilePath);

      // ZIP aç
      fs.mkdirSync(extractDir, { recursive: true });
      await extractZipStreaming(tempFilePath, extractDir);

      // Dosyaları tara
      const allFiles = listAllFilesRecursive(extractDir);

      // bulletin.inf oku
      const bulletinFile = allFiles.find((p) =>
        ["bulletin.inf", "bulletin"].includes(path.basename(p).toLowerCase())
      );
      if (!bulletinFile) throw new Error("bulletin.inf bulunamadı.");

      const content = fs.readFileSync(bulletinFile, "utf8");
      const bulletinNo = (content.match(/NO\s*=\s*(.*)/) || [])[1]?.trim() || "Unknown";
      const bulletinDate = (content.match(/DATE\s*=\s*(.*)/) || [])[1]?.trim() || "Unknown";

      const bulletinRef = await adminDb.collection("trademarkBulletins").add({
        bulletinNo,
        bulletinDate,
        type: "marka",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const bulletinId = bulletinRef.id;

      console.log(`📊 Bülten kaydedildi: ${bulletinNo} (${bulletinDate}) → ${bulletinId}`);

      // script parsing
      const scriptPath = allFiles.find(
        (p) => path.basename(p).toLowerCase() === "tmbulletin.log"
      );
      if (!scriptPath) throw new Error("tmbulletin.log bulunamadı.");

      const records = await parseScriptContentStreaming(scriptPath);

      // IMAGE PATH OLUŞTURMA
      const imagesDir = allFiles.filter((p) => p.includes(path.sep + "images" + path.sep));
      const imagePathMap = {};
      for (const imgPath of imagesDir) {
        const filename = path.basename(imgPath);
        const match = filename.match(/^(\d{4})[_\-]?(\d{5,})/);
        if (match) {
          const appNo = `${match[1]}/${match[2]}`;
          if (!imagePathMap[appNo]) imagePathMap[appNo] = [];
          imagePathMap[appNo].push(
            `bulletins/trademark_${bulletinNo}_images/${filename}`
          );
        }
      }

      // **CHUNK UPLOAD - Bellek dostu**
      const CHUNK_SIZE = 200; // Aynı anda en fazla 50 dosya
      for (let i = 0; i < imagesDir.length; i += CHUNK_SIZE) {
        const chunk = imagesDir.slice(i, i + CHUNK_SIZE);
        console.log(`📦 Görsel chunk yükleniyor: ${i + 1}-${i + chunk.length}/${imagesDir.length}`);

        await Promise.all(
          chunk.map((localPath) => {
            const destination = `bulletins/trademark_${bulletinNo}_images/${path.basename(localPath)}`;
            return bucket.upload(localPath, {
              destination,
              metadata: { contentType: getContentType(localPath) }
            });
          })
        );

        console.log(`✅ Chunk tamamlandı (${i + chunk.length}/${imagesDir.length})`);
        if (global.gc) {
          global.gc();
          console.log("🧹 Garbage collection tetiklendi (chunk sonrası)");
        }
      }

      console.log(`📷 ${imagesDir.length} görsel doğrudan yüklendi`);

      // Firestore kayıtları (imagePath eşleştirilmiş)
      await writeBatchesToFirestore(records, bulletinId, bulletinNo,imagePathMap);

      // 1. ADIM: Arama Performansı İçin Hafif JSON İndeksi Oluşturma (RAM DOSTU)
      try {
        console.log("⚡ Arama indeksi (JSON) oluşturuluyor...");

        const searchIndex = records.map(item => ({
          id: item.id,
          n: (item.markName || "").toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, '').trim(),
          o: item.markName || "",
          c: item.niceClasses || [],
          an: item.applicationNo || "",
          d: item.applicationDate || "",
          i: item.imagePath || "" // <--- ✅ BU SATIRI EKLEYİN (Görsel Yolu)
        }));


      const ndjsonString = searchIndex.map(item => JSON.stringify(item)).join('\n');
      const indexFileName = `bulletins/${bulletinNo}_index.json`;
      const bucket = admin.storage().bucket();
      
      // Dosyayı kaydediyoruz (İsmi aynı kalabilir veya .ndjson yapabilirsiniz)
      await bucket.file(indexFileName).save(ndjsonString, {
        contentType: "application/x-ndjson", // veya application/json
        resumable: false
      });

      console.log(`🚀 Arama indeksi (NDJSON) oluşturuldu: ${indexFileName}`);
      } catch (error) {
        console.error("❌ JSON İndeks oluşturulurken hata:", error);
      }

      console.log(
        `🎉 ZIP işleme tamamlandı: ${bulletinNo} → ${records.length} kayıt, ${imagesDir.length} görsel bulundu.`
      );
    } catch (e) {
      console.error("❌ Hata:", e.message);
      throw e;
    } finally {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    }

    return null;
  }
);


// =========================================================
//              HELPER FONKSİYONLARI
// =========================================================

/**
 * IPRecord'daki applicants dizisindeki her kişi için e-posta alıcılarını belirler
 * @param {Array} applicants IPRecord'daki applicants dizisi
 * @param {string} notificationType Bildirim türü (örn: 'marka')
 * @returns {Promise<{to: string[], cc: string[]}>} Alıcı listeleri
 */
// Düzeltilmiş getRecipientsByApplicantIds fonksiyonu
async function getRecipientsByApplicantIds(applicants, notificationType = 'marka') {
  console.log("🚀 getRecipientsByApplicantIds başlatıldı");
  console.log("📋 Applicants:", applicants);
  console.log("🔍 Notification type:", notificationType);
  
  const typeKey = notificationType === 'trademark' ? 'marka' : notificationType;
  console.log("🗝️ Type key:", typeKey);
  
  const toRecipients = new Set();
  const ccRecipients = new Set();
  
  const addEmails = (set, val, label) => {
    const arr = Array.isArray(val) ? val :
      (typeof val === 'string' ? [val] : []);
    for (const e of arr.map(x => String(x).trim()).filter(Boolean)) {
      set.add(e);
      console.log(`📧 ${label} eklendi: ${e}`);
    }
  };

  if (!Array.isArray(applicants) || applicants.length === 0) {
    console.warn("❌ Applicants dizisi boş veya null");
    return { to: [], cc: [] };
  }

  // Applicant ID'lerini topla
  const applicantIds = applicants
    .map(a => a?.id || a?.personId)
    .filter(Boolean);
  
  console.log("📋 Applicant ID'leri:", applicantIds);

  if (applicantIds.length === 0) {
    console.warn("❌ Geçerli applicant ID'si bulunamadı");
    return { to: [], cc: [] };
  }

  try {
    // TÜM personsRelated kayıtlarını bul (applicant'lara ait olan)
    const prQuery = await adminDb.collection("personsRelated")
      .where("personId", "in", applicantIds)
      .get();

    console.log(`📊 Bulunan personsRelated kayıt sayısı: ${prQuery.docs.length}`);

    // Her personsRelated kaydını işle
    for (const prDoc of prQuery.docs) {
      const pr = prDoc.data() || {};
      const personId = pr.personId;
      
      console.log(`\n🔍 İşlenen personsRelated kaydı - PersonID: ${personId}`);
      console.log(`📄 Kayıt ID: ${prDoc.id}`);
      
      // Bu kişi bu notification type için responsible mı?
      const isResponsible = pr?.responsible?.[typeKey] === true;
      console.log(`🔍 responsible[${typeKey}] = ${String(isResponsible)}`);

      if (!isResponsible) {
        console.log(`❌ Person ${personId} sorumlu değil - '${typeKey}' için`);
        continue;
      }

      // Notify ayarlarını al
      const ns = pr?.notify?.[typeKey] || {};
      console.log(`🔎 notify[${typeKey}] =`, JSON.stringify(ns));

      // Email adresi al (personsRelated'deki email öncelikli, yoksa persons'dan)
      let personEmail = (pr.email || '').trim();
      
      if (!personEmail) {
        // persons koleksiyonundan email al
        try {
          const personSnap = await adminDb.collection("persons").doc(personId).get();
          if (personSnap.exists) {
            const person = personSnap.data() || {};
            personEmail = (person.email || '').trim();
            console.log(`✅ Person email bulundu: ${personEmail || '(yok)'}`);
          }
        } catch (err) {
          console.error(`❌ Person email alınamadı - ${personId}:`, err);
        }
      } else {
        console.log(`✅ PersonsRelated email kullanılıyor: ${personEmail}`);
      }

      // TO/CC ekleme işlemleri
      if (personEmail) {
        if (ns.to === true) { 
          toRecipients.add(personEmail);  
          console.log(`📧 TO (${prDoc.id}): ${personEmail}`); 
        }
        if (ns.cc === true) { 
          ccRecipients.add(personEmail);  
          console.log(`📧 CC (${prDoc.id}): ${personEmail}`); 
        }
      } else {
        if (ns.to === true || ns.cc === true) {
          console.warn(`⚠️ Email eksik - PersonID: ${personId}, Record: ${prDoc.id}`);
        }
      }

      // Ek email listelerini ekle
      addEmails(toRecipients, ns.toList,   `TO (${prDoc.id}-toList)`);
      addEmails(toRecipients, ns.toEmails, `TO (${prDoc.id}-toEmails)`);
      if (Array.isArray(ns.to)) addEmails(toRecipients, ns.to, `TO (${prDoc.id}-to[])`);

      addEmails(ccRecipients, ns.ccList,   `CC (${prDoc.id}-ccList)`);
      addEmails(ccRecipients, ns.ccEmails, `CC (${prDoc.id}-ccEmails)`);
      if (Array.isArray(ns.cc)) addEmails(ccRecipients, ns.cc, `CC (${prDoc.id}-cc[])`);

      // Opsiyonel: personsRelated.emails[typeKey]
      const prEmails = pr?.emails?.[typeKey] || {};
      addEmails(toRecipients, prEmails.to, `TO (${prDoc.id}-pr.emails)`);
      addEmails(ccRecipients, prEmails.cc, `CC (${prDoc.id}-pr.emails)`);
    }

  } catch (err) {
    console.error("❌ personsRelated sorgu hatası:", err);
  }

  const result = { to: Array.from(toRecipients), cc: Array.from(ccRecipients) };
  console.log("🎯 FINAL RESULT:");
  console.log("📧 TO recipients:", result.to);
  console.log("📧 CC recipients:", result.cc);
  console.log("📊 TO count:", result.to.length);
  console.log("📊 CC count:", result.cc.length);
  return result;
}

/**
 * evrekaMailCCList koleksiyonundan CC adreslerini getirir.
 * - transactionTypes === "All" olanların hepsi
 * - transactionTypes array-contains <txType> olanlar
 * @param {number|string} txType
 * @returns {Promise<string[]>}
 */
async function getCcFromEvrekaListByTransactionType(txType) {
  console.log("🔍 [EVREKA-CC] Fonksiyon çağrıldı:", { txType, type: typeof txType });
  
  const emails = new Set();

  try {
    // 1) transactionTypes array'inde number arama
    const n = typeof txType === "number" ? txType : parseInt(txType, 10);
    console.log("🔍 [EVREKA-CC] Parsed number:", { n, isValid: !Number.isNaN(n) });
    
    if (!Number.isNaN(n)) {
      const arrSnap = await adminDb.collection("evrekaMailCCList")
        .where("transactionTypes", "array-contains", n)
        .get();
      console.log(`🔍 [EVREKA-CC] Number query sonuç: ${arrSnap.size} docs`);
      
      arrSnap.forEach(d => {
        const e = (d.data()?.email || "").trim();
        console.log(`✅ [EVREKA-CC] Number match: ${d.id} -> ${e}`);
        if (e) emails.add(e);
      });
    }

    // 2) transactionTypes = "All" string değeri olanları ekle (== ile)
    const allSnap = await adminDb.collection("evrekaMailCCList")
      .where("transactionTypes", "==", "All")
      .get();
    console.log(`🔍 [EVREKA-CC] "All" query sonuç: ${allSnap.size} docs`);
    
    allSnap.forEach(d => {
      const e = (d.data()?.email || "").trim();
      console.log(`✅ [EVREKA-CC] "All" match: ${d.id} -> ${e}`);
      if (e) emails.add(e);
    });

    const result = Array.from(emails);
    console.log("🎯 [EVREKA-CC] Final result:", result);
    return result;
  } catch (err) {
    console.error("❌ [EVREKA-CC] evrekaMailCCList sorgu hatası:", err);
    return [];
  }
}
async function downloadWithStream(file, destination) {
  await pipeline(file.createReadStream(), fs.createWriteStream(destination));
}
async function extractZipStreaming(zipPath, extractDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const outputPath = path.join(extractDir, entry.entryName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, zip.readFile(entry));
  }
}
function listAllFilesRecursive(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(listAllFilesRecursive(fullPath));
    } else {
      results.push(fullPath);
    }
  });
  return results;
}
async function parseScriptContentStreaming(scriptPath) {
  const stats = fs.statSync(scriptPath);
  console.log(`📏 Script dosya boyutu: ${stats.size} bytes`);
  
  if (stats.size > 100 * 1024 * 1024) {
    console.log("🔄 Büyük dosya - chunk'lı parsing kullanılıyor");
    return parseScriptInChunks(scriptPath);
  }
  
  console.log("🔄 Normal parsing kullanılıyor");
  const content = fs.readFileSync(scriptPath, "utf8");
  return parseScriptContent(content);
}
function parseScriptContent(content) {
  console.log(`🔍 Parse başlıyor... Content length: ${content.length} karakter`);
  
  const recordsMap = {};
  const lines = content.split('\n');
  
  console.log(`📝 Toplam satır sayısı: ${lines.length}`);
  
  let processedLines = 0;
  let insertCount = 0;
  let valuesParsed = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (!line.length || !line.startsWith('INSERT INTO')) {
      continue;
    }
    
    processedLines++;
    insertCount++;
    
    if (processedLines % 1000 === 0) {
      console.log(`📈 İşlenen satır: ${processedLines}/${lines.length}`);
    }
    
    // ESKİ ÇALIŞAN REGEX PATTERN
    const match = line.match(/INSERT INTO (\w+) VALUES\s*\((.*)\)$/);
    if (!match) {
      if (insertCount <= 5) {
        console.warn(`⚠️ Regex eşleşmedi (satır ${i + 1}): ${line.substring(0, 100)}...`);
      }
      continue;
    }
    
    const table = match[1].toUpperCase();
    const valuesRaw = match[2];
    
    // MEVCUT parseValuesFromRaw FONKSİYONUNU KULLAN
    const values = parseValuesFromRaw(valuesRaw);
    
    if (!values || values.length === 0) {
      if (valuesParsed < 3) {
        console.warn(`⚠️ VALUES parse edilemedi: ${valuesRaw.substring(0, 50)}...`);
      }
      continue;
    }
    
    valuesParsed++;
    
    if (valuesParsed <= 3) {
      console.log(`✅ Parse başarılı (${table}):`, {
        appNo: values[0],
        totalValues: values.length,
        sample: values.slice(0, 3)
      });
    }
    
    const appNo = values[0];
    if (!appNo) continue;

    if (!recordsMap[appNo]) {
      recordsMap[appNo] = {
        applicationNo: appNo,
        applicationDate: null,
        markName: null,
        niceClasses: null,
        holders: [],
        goods: [],
        extractedGoods: [],
        attorneys: [],
      };
    }

    if (table === "TRADEMARK") {
      recordsMap[appNo].applicationDate = values[1] ?? null;
      recordsMap[appNo].markName = values[5] ?? null;
      recordsMap[appNo].niceClasses = values[6] ?? null;
    } else if (table === "HOLDER") {
      const holderName = extractHolderName(values[2]);
      let addressParts = [values[3], values[4], values[5], values[6]].filter(Boolean).join(", ");
      if (addressParts.trim() === "") addressParts = null;
      recordsMap[appNo].holders.push({
        name: holderName,
        address: addressParts,
        country: values[7] ?? null,
      });
    } else if (table === "GOODS") {
      recordsMap[appNo].goods.push(values[3] ?? null);
    } else if (table === "EXTRACTEDGOODS") {
      recordsMap[appNo].extractedGoods.push(values[3] ?? null);
    } else if (table === "ATTORNEY") {
      recordsMap[appNo].attorneys.push(values[2] ?? null);
    }
  }
  
  const result = Object.values(recordsMap);
  
  console.log(`✅ Parse tamamlandı:`, {
    totalLines: lines.length,
    processedLines: processedLines,
    insertCount: insertCount,
    valuesParsed: valuesParsed,
    uniqueApplications: result.length,
    successRate: insertCount > 0 ? ((valuesParsed / insertCount) * 100).toFixed(1) + '%' : '0%'
  });
  
  if (result.length > 0) {
    console.log(`📋 İlk kayıt örneği:`, JSON.stringify(result[0], null, 2));
  }
  
  return result;
}
function parseValuesFromRaw(raw) {
  const values = [];
  let current = "";
  let inString = false;
  let i = 0;

  while (i < raw.length) {
    const char = raw[i];
    if (char === "'") {
      if (inString && raw[i + 1] === "'") {
        current += "'";
        i += 2;
        continue;
      } else {
        inString = !inString;
      }
    } else if (char === "," && !inString) {
      values.push(decodeValue(current.trim()));
      current = "";
      i++;
      continue;
    } else {
      current += char;
    }
    i++;
  }
  
  if (current.trim()) {
    values.push(decodeValue(current.trim()));
  }
  
  return values;
}

async function parseScriptInChunks(scriptPath) {
  const fd = fs.openSync(scriptPath, "r");
  const fileSize = fs.statSync(scriptPath).size;
  const chunkSize = 1024 * 1024;
  let buffer = "";
  let position = 0;
  const records = {};
  let currentTable = null;
  while (position < fileSize) {
    const chunk = Buffer.alloc(Math.min(chunkSize, fileSize - position));
    fs.readSync(fd, chunk, 0, chunk.length, position);
    position += chunk.length;
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("INSERT INTO")) {
        const match = line.match(/INSERT INTO (\w+)/);
        currentTable = match ? match[1] : null;
      }
      if (currentTable && line.includes("VALUES")) {
        const values = parseValuesFromLine(line);
        if (!values || !values.length) continue;
        const appNo = values[0];
        if (!records[appNo]) {
          records[appNo] = {
            applicationNo: appNo,
            applicationDate: null,
            markName: null,
            niceClasses: null,
            holders: [],
            goods: [],
            extractedGoods: [],
            attorneys: []
          };
        }
        if (currentTable === "TRADEMARK") {
          records[appNo].applicationDate = values[1] || null;
          records[appNo].markName = values[4] || null;
          records[appNo].niceClasses = values[6] || null;
        } else if (currentTable === "HOLDER") {
          records[appNo].holders.push({
            name: extractHolderName(values[2]),
            address: values[3],
            country: values[4]
          });
        } else if (currentTable === "GOODS") {
          records[appNo].goods.push(values[3]);
        } else if (currentTable === "EXTRACTEDGOODS") {
          records[appNo].extractedGoods.push(values[3]);
        } else if (currentTable === "ATTORNEY") {
          records[appNo].attorneys.push(values[2]);
        }
      }
    }
  }
  fs.closeSync(fd);
  return Object.values(records);
}
function parseValuesFromLine(line) {
  const valuesMatch = line.match(/VALUES\s*\((.*)\)/i);
  if (!valuesMatch) return null;
  
  return parseValuesFromRaw(valuesMatch[1]);
}
function decodeValue(str) {
    if (str === null || str === undefined) return null;
    if (str === "") return null;
    str = str.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
    // \uXXXX formatındaki unicode karakterleri çöz
    return str.replace(/\\u([0-9a-fA-F]{4})/g,
        (m, g1) => String.fromCharCode(parseInt(g1, 16))
    );
}
function extractHolderName(str) {
  if (!str) return null;
  const parenMatch = str.match(/^\(\d+\)\s*(.*)$/);
  return parenMatch ? parenMatch[1].trim() : str.trim();
}
async function writeBatchesToFirestore(records, bulletinId, bulletinNo, imagePathMap) {
  const batchSize = 250;
  for (let i = 0; i < records.length; i += batchSize) {
    const chunk = records.slice(i, i + batchSize);
    const batch = db.batch();
    chunk.forEach((record) => {
      record.bulletinId = bulletinId;
      record.bulletinNo = bulletinNo;
      const matchingImages = imagePathMap[record.applicationNo] || [];
      record.imagePath = matchingImages.length > 0 ? matchingImages[0] : null;
      record.imageUploaded = false;
      const docRef = db.collection("trademarkBulletinRecords").doc();
      record.id = docRef.id; // <--- ÖNEMLİ: ID'yi hafızadaki nesneye de yazıyoruz
      batch.set(docRef, {
        ...record,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    console.log(`📝 ${Math.min(i + batchSize, records.length)}/${records.length} kayıt yazıldı`);
  }
}

function getContentType(filePath) {
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.jpe?g$/i.test(filePath)) return "image/jpeg";
  return "application/octet-stream";
}

// BÜLTEN SİLME 
export const deleteBulletinV2 = onCall(
  { timeoutSeconds: 60, memory: "1GiB", region: "europe-west1" },
  async (request) => {
    try {
      const { bulletinId } = request.data || {};
      if (!bulletinId) {
        throw new HttpsError('invalid-argument', 'BulletinId gerekli.');
      }

      console.log(`🗑️ Silme işlemi başlatılıyor: ${bulletinId}`);

      const operationId = `delete_${bulletinId}_${Date.now()}`;
      const statusRef = db.collection('operationStatus').doc(operationId);
      
      // İlk durumu kaydet
      await statusRef.set({
        operationId,
        bulletinId,
        status: 'queued',
        message: 'Silme kuyruğa alındı...',
        progress: 0,
        startTime: admin.firestore.FieldValue.serverTimestamp(),
        userId: request.auth?.uid || null
      });

      console.log(`✅ Operation status created: ${operationId}`);

      // Topic oluştur/kontrol et
      try {
        await ensureTopic('bulletin-deletion');
        console.log('✅ Topic ensured: bulletin-deletion');
      } catch (topicError) {
        console.error('❌ Topic creation failed:', topicError);
        await statusRef.update({
          status: 'error',
          message: `Topic oluşturulamadı: ${topicError.message}`,
          endTime: admin.firestore.FieldValue.serverTimestamp()
        });
        throw new HttpsError('internal', `Topic oluşturulamadı: ${topicError.message}`);
      }

      // Pub/Sub mesajını yayınla
      try {
        const messageId = await pubsubClient.topic('bulletin-deletion').publishMessage({
          json: { bulletinId, operationId }
        });
        console.log(`✅ Pub/Sub message published: ${messageId}`);
        
        await statusRef.update({
          message: 'Mesaj kuyruğa gönderildi, işlem başlatılıyor...',
          progress: 5,
          pubsubMessageId: messageId
        });
        
      } catch (publishError) {
        console.error('❌ Pub/Sub publish failed:', publishError);
        await statusRef.update({
          status: 'error',
          message: `Mesaj gönderilemedi: ${publishError.message}`,
          endTime: admin.firestore.FieldValue.serverTimestamp()
        });
        throw new HttpsError('internal', `Mesaj gönderilemedi: ${publishError.message}`);
      }

      return { success: true, operationId, message: 'Silme işlemi kuyruğa alındı.' };
    } catch (error) {
      console.error('❌ deleteBulletinV2 error:', error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError('internal', String(error?.message || error));
    }
  }
);

// Gerçek silme işlemini yapan fonksiyon
async function performBulletinDeletion(bulletinId, operationId) {
  const statusRef = db.collection('operationStatus').doc(operationId);
  
  try {
    console.log(`🔥 Gerçek silme işlemi başladı: ${bulletinId}`);
    
    // === 1. Bülten dokümanını al ===
    const bulletinDoc = await db.collection('trademarkBulletins').doc(bulletinId).get();
    if (!bulletinDoc.exists) {
      throw new Error('Bülten bulunamadı.');
    }

    const bulletinData = bulletinDoc.data();
    const bulletinNo = bulletinData.bulletinNo;
    console.log(`📋 Silinecek bülten: ${bulletinNo}`);

    await statusRef.update({
      status: 'in_progress',
      message: `Bülten ${bulletinNo} kayıtları siliniyor...`,
      progress: 10
    });

    // === 2. İlişkili trademarkBulletinRecords silme (BulkWriter, hızlı) ===
    let totalRecordsDeleted = 0;

    // Sadece referans/id yeterli; network yükünü azaltmak için select() kullan
    const baseQuery = db.collection('trademarkBulletinRecords')
      .where('bulletinId', '==', bulletinId)
      .select();

    const writer = admin.firestore().bulkWriter({
      throttling: { initialOpsPerSecond: 500, maxOpsPerSecond: 2000 }
    });

    let lastDoc = null;
    while (true) {
      let q = baseQuery.limit(1000);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      for (const d of snap.docs) {
        writer.delete(d.ref);
      }
      totalRecordsDeleted += snap.size;
      lastDoc = snap.docs[snap.docs.length - 1];

      console.log(`✅ ${totalRecordsDeleted} kayıt silme kuyruğa alındı`);

      // İlerlemeyi güncelle (80'e kadar)
      await statusRef.update({
        message: `${totalRecordsDeleted} kayıt siliniyor...`,
        progress: Math.min(30 + Math.floor(totalRecordsDeleted / 100), 80)
      });
    }

    // Kuyruğun bitmesini bekle
    await writer.close();
    console.log(`✅ Toplam silinen kayıt: ${totalRecordsDeleted}`);

    await statusRef.update({
      message: 'Storage dosyaları siliniyor...',
      progress: 85
    });

  // === 3. Storage'dan görselleri sil (hızlı, toplu) ===
  let totalImagesDeleted = 0;
  try {
    const bucket = admin.storage().bucket();

    // Yükleme ile uyumlu gerçek klasör + geçmiş/yanlış path için ek prefix
    const prefixes = [
      `bulletins/trademark_${bulletinNo}_images/`,
      `trademark_images/${bulletinNo}/`
    ];

    for (const pfx of prefixes) {
      try {
        // Önce sayıyı ölç (log/istatistik için), sonra toplu sil
        const [files] = await bucket.getFiles({ prefix: pfx });
        if (files.length > 0) {
          console.log(`🖼️ ${pfx} altında ${files.length} dosya bulundu — toplu siliniyor...`);
          await bucket.deleteFiles({ prefix: pfx, force: true }); // ✅ çok daha hızlı
          totalImagesDeleted += files.length;
          console.log(`✅ ${pfx} temizlendi`);
        } else {
          console.log(`ℹ️ ${pfx} altında dosya yok`);
        }
      } catch (delErr) {
        console.warn(`⚠️ ${pfx} temizleme hatası:`, delErr?.message || delErr);
      }
    }
  } catch (storageError) {
    console.warn('⚠️ Storage silme hatası:', storageError?.message || storageError);
  }

  await statusRef.update({
    message: 'Ana bülten kaydı siliniyor...',
    progress: 95
  });

    // === 4. Ana bülten dokümanını sil ===
    await bulletinDoc.ref.delete();
    
    // === 5. Başarı durumunu güncelle ===
    await statusRef.update({
      status: 'completed',
      message: `Bülten ${bulletinNo} başarıyla silindi! Kayıtlar: ${totalRecordsDeleted}, Görseller: ${totalImagesDeleted}`,
      progress: 100,
      endTime: admin.firestore.FieldValue.serverTimestamp(),
      recordsDeleted: totalRecordsDeleted,
      imagesDeleted: totalImagesDeleted
    });

    console.log(`🎉 Bülten ${bulletinNo} başarıyla silindi!`);
    
  } catch (error) {
    console.error('❌ Silme işlemi hatası:', error);
    
    await statusRef.update({
      status: 'error',
      message: `Hata: ${error.message}`,
      endTime: admin.firestore.FieldValue.serverTimestamp()
    });
  }
}

// Bu modüllerin functions/ altında da bulunması veya fonksiyon içine taşınması gerekecek.
// Şimdilik varsayımsal olarak import edeceğiz ve deployment sırasında düzenleme gerekebilir.
// Eğer bu helper dosyalarını (preprocess, visual-match, phonetic) functions klasörüne kopyalamazsanız,
// aşağıdaki import yollarını Node.js ortamına uygun olarak ayarlamanız veya bu kodları doğrudan bu dosya içine taşımanız gerekebilir.
// En temiz yöntem, bu helper'ları functions klasörünün altında ayrı bir utils veya helperlar klasörüne taşımaktır.
// Şimdilik fonksiyonun içine doğrudan kopyalayacağım ki ek dosya bağımlılığı olmasın.


// ======== Yardımcı Fonksiyonlar ve Algoritmalar (scorer.js, preprocess.js, visual-match.js, phonetic.js'ten kopyalandı) ========

// GENERIC_WORDS (preprocess.js'ten kopyalandı)
const GENERIC_WORDS = [// ======== ŞİRKET TİPLERİ ========
    'ltd', 'şti', 'aş', 'anonim', 'şirketi', 'şirket', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'llc', 'group', 'grup',

    // ======== TİCARİ SEKTÖRLER ========
    'sanayi', 'ticaret', 'turizm', 'tekstil', 'gıda', 'inşaat', 'danışmanlık', 'hizmet', 'hizmetleri', 'bilişim', 'teknoloji', 'sigorta', 'yayıncılık', 'mobilya', 'otomotiv', 'tarım', 'enerji', 'petrol', 'kimya', 'kozmetik', 'ilaç', 'medikal', 'sağlık', 'eğitim', 'spor', 'müzik', 'film', 'medya', 'reklam', 'pazarlama', 'lojistik', 'nakliyat', 'kargo', 'finans', 'bankacılık', 'emlak', 'gayrimenkul', 'madencilik', 'metal', 'plastik', 'cam', 'seramik', 'ahşap',

    // ======== MESLEKİ TERİMLER ========
    'mühendislik', 'proje', 'taahhüt', 'ithalat', 'ihracat', 'üretim', 'imalat', 'veteriner', 'petshop', 'polikliniği', 'hastane', 'klinik', 'müşavirlik', 'muhasebe', 'hukuk', 'avukatlık', 'mimarlık', 'peyzaj', 'tasarım', 'dizayn', 'design', 'grafik', 'web', 'yazılım', 'software', 'donanım', 'hardware', 'elektronik', 'elektrik', 'makina', 'makine', 'endüstri', 'fabrika', 'laboratuvar', 'araştırma', 'geliştirme', 'ofis', // 'ofis' eklendi

    // ======== ÜRÜN/HİZMET TERİMLERİ ========
    'ürün', // 'ürün' kökü eklendi (ürünleri, ürünler gibi varyasyonları kapsayacak)
    'products', 'services', 'solutions', 'çözüm', // 'çözümleri' yerine 'çözüm' kökü
    'sistem', 'systems', 'teknolojileri', 'teknoloji', // 'teknolojileri' yanına 'teknoloji'
    'malzeme', 'materials', 'ekipman', 'equipment', 'cihaz', 'device', 'araç', 'tools', 'yedek', 'parça', 'parts', 'aksesuar', 'accessories', 'gereç', 'malzeme',

    // ======== GENEL MARKALAŞMA TERİMLERİ ========
    'meşhur', 'ünlü', 'famous', 'since', 'est', 'established', 'tarihi', 'historical', 'geleneksel', 'traditional', 'klasik', 'classic', 'yeni', 'new', 'fresh', 'taze', 'özel', 'special', 'premium', 'lüks', 'luxury', 'kalite', // 'kalite' eklendi
    'quality', 'uygun', // 'uygun' eklendi

    // ======== LOKASYON TERİMLERİ ========
    'turkey', 'türkiye', 'international', 'uluslararası',

    // ======== EMLAK TERİMLERİ ========
    'realestate', 'emlak', 'konut', 'housing', 'arsa', 'ticari', 'commercial', 'ofis', 'office', 'plaza', 'shopping', 'alışveriş', 'residence', 'rezidans', 'villa', 'apartment', 'daire',

    // ======== DİJİTAL TERİMLERİ ========
    'online', 'digital', 'dijital', 'internet', 'web', 'app', 'mobile', 'mobil', 'network', 'ağ', 'server', 'sunucu', 'hosting', 'domain', 'platform', 'social', 'sosyal', 'media', 'medya',

    // ======== GIDA TERİMLERİ ========
    'gıda', 'food', 'yemek', 'restaurant', 'restoran', 'cafe', 'kahve', 'coffee', 'çay', 'tea', 'fırın', 'bakery', 'ekmek', 'bread', 'pasta', 'börek', 'pizza', 'burger', 'kebap', 'döner', 'pide', 'lahmacun', 'balık', 'fish', 'et', 'meat', 'tavuk', 'chicken', 'sebze', 'vegetable', 'meyve', 'fruit', 'süt', 'milk', 'peynir', 'cheese', 'yoğurt', 'yogurt', 'dondurma', 'şeker', 'sugar', 'bal', 'reçel', 'jam', 'konserve', 'canned', 'organic', 'organik', 'doğal', 'natural', 'taze', 'fresh',

    // ======== BAĞLAÇLAR ve Yaygın Kelimeler ========
    've', 'ile', 'için', 'bir', 'bu', 'da', 'de', 'ki', 'mi', 'mı', 'mu', 'mü',
    'sadece', 'tek', 'en', 'çok', 'az', 'üst', 'alt', 'yeni', 'eski'
];

function removeTurkishSuffixes(word) {
    if (!word) return '';
    
    // Çoğul ekleri: -ler, -lar
    if (word.endsWith('ler') || word.endsWith('lar')) {
        return word.substring(0, word.length - 3);
    }
    // İyelik ekleri (basit formlar): -im, -in, -i, -ımız, -ınız, -ları
    // Örneğin, 'ofisi' -> 'ofis'
    if (word.endsWith('si') || word.endsWith('sı') || word.endsWith('sü') || word.endsWith('su')) {
        return word.substring(0, word.length - 2);
    }
    if (word.endsWith('i') || word.endsWith('ı') || word.endsWith('u') || word.endsWith('ü')) {
        // 'gıda' gibi kelimelerde 'ı' son ek olmamalı, bu yüzden dikkatli olmalı
        // Daha güvenli bir kontrol için kelime kökü kontrol edilebilir
        // Şimdilik sadece iyelik ve yönelme eklerini çıkarıyoruz.
        // Basitçe son harfi kaldırmak riskli, ama şimdilik en yaygın olanları ele alalım
        if (word.length > 2 && ['i', 'ı', 'u', 'ü'].includes(word[word.length - 1])) {
             // 'ofis' gibi kelimelerde 'i' iyelik eki olabilir.
             // Daha sofistike bir çözüm için NLP kütüphanesi gerekir, bu basit bir yaklaşımdır.
             return word.substring(0, word.length - 1);
        }
    }
    // Fiilimsiler, durum ekleri vb. için daha karmaşık kurallar gerekebilir
    
    return word;
}

/**
 * Marka adını temizler: küçük harfe çevirir, özel karakterleri kaldırır, stopwords'ü çıkarır.
 *
 * @param {string} name Marka adı
 * @param {boolean} removeGenericWords Stopwords'ün çıkarılıp çıkarılmayacağını belirler.
 * Genellikle çok kelimeli isimler için true olmalı.
 * @returns {string} Temizlenmiş marka adı.
 */
export function cleanMarkName(name, removeGenericWords = true) {
    if (!name) return '';
    let cleaned = name.toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, '').trim(); // Harf, rakam ve boşluk dışındaki her şeyi kaldır

    // Birden fazla boşluğu tek boşluğa indirge
    cleaned = cleaned.replace(/\s+/g, ' ');

    if (removeGenericWords) {
        // Kelimelere ayır, eklerini kaldır ve stopwords olmayanları filtrele
        cleaned = cleaned.split(' ').filter(word => {
            const stemmedWord = removeTurkishSuffixes(word);
            // Kök kelime veya orijinal kelime stopwords listesinde mi kontrol et
            return !GENERIC_WORDS.includes(stemmedWord) && !GENERIC_WORDS.includes(word);
        }).join(' ');
    }

    return cleaned.trim();
}

// visual-match.js'ten kopyalandı
const visualMap = {
    "a": ["e", "o"], "b": ["d", "p"], "c": ["ç", "s"], "ç": ["c", "s"], "d": ["b", "p"], "e": ["a", "o"], "f": ["t"],
    "g": ["ğ", "q"], "ğ": ["g", "q"], "h": ["n"], "i": ["l", "j", "ı"], "ı": ["i"], "j": ["i", "y"], "k": ["q", "x"],
    "l": ["i", "1"], "m": ["n"], "n": ["m", "r"], "o": ["a", "0", "ö"], "ö": ["o"], "p": ["b", "q"], "q": ["g", "k"],
    "r": ["n"], "s": ["ş", "c", "z"], "ş": ["s", "z"], "t": ["f"], "u": ["ü", "v"], "ü": ["u", "v"], "v": ["u", "ü", "w"],
    "w": ["v"], "x": ["ks"], "y": ["j"], "z": ["s", "ş"], "0": ["o"], "1": ["l", "i"], "ks": ["x"], "Q": ["O","0"],
    "O": ["Q", "0"], "I": ["l", "1"], "L": ["I", "1"], "Z": ["2"], "S": ["5"], "B": ["8"], "D": ["O"]
};

function visualMismatchPenalty(a, b) {
    if (!a || !b) return 5; 

    const lenDiff = Math.abs(a.length - b.length);
    const minLen = Math.min(a.length, b.length);
    let penalty = lenDiff * 0.5;

    for (let i = 0; i < minLen; i++) {
        const ca = a[i].toLowerCase();
        const cb = b[i].toLowerCase();

        if (ca !== cb) {
            if (visualMap[ca] && visualMap[ca].includes(cb)) {
                penalty += 0.25;
            } else {
                penalty += 1.0;
            }
        }
    }
    return penalty;
}

// phonetic.js'ten kopyalandı
function normalizeString(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .replace(/[^a-z0-9ğüşöçı]/g, '')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/ı/g, 'i');
}

function isPhoneticallySimilar(a, b) {
    if (!a || !b) return 0.0;

    a = normalizeString(a);
    b = normalizeString(b);

    if (a === b) return 1.0;

    const lenA = a.length;
    const lenB = b.length;
    const minLen = Math.min(lenA, lenB);
    const maxLen = Math.max(lenA, lenB);

    if (maxLen === 0) return 1.0;
    if (maxLen > 0 && minLen === 0) return 0.0;

    const lengthMismatchPenalty = Math.abs(lenA - lenB) / maxLen;
    let score = 1.0 - lengthMismatchPenalty;

    let matchingChars = 0;
    const matchedA = new Array(lenA).fill(false);
    const matchedB = new Array(lenB).fill(false);

    const searchRange = Math.min(maxLen, Math.floor(maxLen / 2) + 1);
    for (let i = 0; i < lenA; i++) {
        for (let j = Math.max(0, i - searchRange); j < Math.min(lenB, i + searchRange + 1); j++) {
            if (a[i] === b[j] && !matchedB[j]) {
                matchingChars++;
                matchedA[i] = true;
                matchedB[j] = true;
                break;
            }
        }
    }

    if (matchingChars === 0) return 0.0;

    const commonality = matchingChars / Math.max(lenA, lenB);
    
    let positionalBonus = 0;
    if (lenA > 0 && lenB > 0) {
        if (a[0] === b[0]) positionalBonus += 0.2;
        if (lenA > 1 && lenB > 1 && a[1] === b[1]) positionalBonus += 0.1;
    }

    score = (commonality * 0.7) + (positionalBonus * 0.3);

    return Math.max(0.0, Math.min(1.0, score));
}
function parseDate(value) {
  if (!value) return null;
  
  // dd/MM/yyyy formatı desteği (Türkiye standartı)
  const parts = value.split('/');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // 0-indexed
    const year = parseInt(parts[2], 10);
    
    // Geçerlilik kontrolü ekleyin
    if (day > 0 && day <= 31 && month >= 0 && month <= 11 && year > 1900) {
      return new Date(year, month, day);
    }
  }
  
  // ISO formatı veya başka formatlar için
  const isoDate = new Date(value);
  return isNaN(isoDate) ? null : isoDate;
}

function isValidBasedOnDate(hitDate, monitoredDate) {
  if (!hitDate || !monitoredDate) return true;

  const hit = parseDate(hitDate);
  const monitored = parseDate(monitoredDate);

  if (!hit || !monitored || isNaN(hit) || isNaN(monitored)) return true;

  // doğru mantık
  return hit >= monitored;
}

// functions/index.js - Düzeltilmiş nice sınıf fonksiyonu

function hasOverlappingNiceClasses(monitoredTrademark, bulletinRecordNiceClasses) {
  logger.log("🏷️ Nice sınıf karşılaştırması:", {
    monitoredTrademarkId: monitoredTrademark.id,
    monitoredNiceClassSearch: monitoredTrademark.niceClassSearch,
    bulletinRecordNiceClasses,
    bulletinRecordType: typeof bulletinRecordNiceClasses
  });
  
  try {
    // İzlenen markadan niceClassSearch array'ini al
    const monitoredNiceClassSearch = monitoredTrademark.niceClassSearch || [];
    
    // Eğer izlenen markanın niceClassSearch'u yoksa, sınıf filtresini atla
    if (!Array.isArray(monitoredNiceClassSearch) || monitoredNiceClassSearch.length === 0) {
      logger.log("ℹ️ İzlenen markanın niceClassSearch'u yok, filtre atlanıyor");
      return true;
    }
    
    // Bülten kaydında nice sınıf yoksa çakışma yok
    if (!bulletinRecordNiceClasses) {
      logger.log("ℹ️ Bülten kaydında nice sınıf yok, çakışma yok");
      return false;
    }

    // Nice sınıfları normalize et (sadece rakamları al ve array'e çevir)
    const normalizeNiceClasses = (classes) => {
      if (!classes) return [];
      
      let classArray = [];
      
      if (Array.isArray(classes)) {
        classArray = classes;
      } else if (typeof classes === 'string') {
        // String ise önce " / " ile böl, sonra diğer ayırıcılarla da böl
        classArray = classes.split(/[\s\/,]+/).filter(c => c.trim());
      } else {
        classArray = [String(classes)];
      }
      
      // Her sınıftan sadece rakamları al
      return classArray
        .map(cls => String(cls).replace(/\D/g, '')) // Sadece rakamları al
        .filter(cls => cls && cls.length > 0); // Boş olanları çıkar
    };
    
    const monitoredClasses = normalizeNiceClasses(monitoredNiceClassSearch);
    const bulletinRecordClasses = normalizeNiceClasses(bulletinRecordNiceClasses);
    
    logger.log("🔧 Normalize edilmiş sınıflar:", {
      monitoredClasses: monitoredClasses,
      bulletinRecordClasses: bulletinRecordClasses
    });
    
    // Bülten kaydı sınıfları boşsa çakışma yok
    if (bulletinRecordClasses.length === 0) {
      logger.log("ℹ️ Bülten kaydı sınıfları boş, çakışma yok");
      return false;
    }
    
    // Kesişim kontrolü
    const hasOverlap = monitoredClasses.some(monitoredClass => 
      bulletinRecordClasses.some(bulletinClass => monitoredClass === bulletinClass)
    );
    
    logger.log(`🏷️ Nice sınıf kesişimi: ${hasOverlap ? 'VAR' : 'YOK'}`);
    
    // Debug: hangi sınıflar eşleşti?
    if (hasOverlap) {
      const matchingClasses = monitoredClasses.filter(monitoredClass => 
        bulletinRecordClasses.some(bulletinClass => monitoredClass === bulletinClass)
      );
      logger.log(`✅ Eşleşen sınıflar: ${matchingClasses.join(', ')}`);
    }
    
    return hasOverlap;
    
  } catch (error) {
    logger.error('❌ Nice class karşılaştırma hatası:', error);
    return false;
  }
}

// ======== Ana Benzerlik Skorlama Fonksiyonu (scorer.js'ten kopyalandı) ========
function levenshteinDistance(a, b) {
  const matrix = [];

  const lenA = a.length;
  const lenB = b.length;

  for (let i = 0; i <= lenB; i++) matrix[i] = [i];
  for (let j = 0; j <= lenA; j++) matrix[0][j] = j;

  for (let i = 1; i <= lenB; i++) {
    for (let j = 1; j <= lenA; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[lenB][lenA];
}

function levenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : (1 - distance / maxLen);
}

// functions/index.js içindeki calculateSimilarityScoreInternal fonksiyonunu bununla değiştirin

function calculateSimilarityScoreInternal(hitMarkName, searchMarkName, hitApplicationDate, searchApplicationDate, hitNiceClasses, searchNiceClasses) {
    // Jenerik ibare temizliği
    const isSearchMultiWord = searchMarkName.trim().split(/\s+/).length > 1;
    const isHitMultiWord = (hitMarkName || '').trim().split(/\s+/).length > 1;

    const cleanedSearchName = cleanMarkName(searchMarkName || '', isSearchMultiWord).toLowerCase().trim();
    const cleanedHitName = cleanMarkName(hitMarkName || '', isHitMultiWord).toLowerCase().trim();

    // Log satırı kaldırıldı
    
    if (!cleanedSearchName || !cleanedHitName) {
        return { finalScore: 0.0, positionalExactMatchScore: 0.0 }; 
    }

    // Tam eşleşme kontrolü (en yüksek öncelik)
    if (cleanedSearchName === cleanedHitName) {
        return { finalScore: 1.0, positionalExactMatchScore: 1.0 }; 
    }

    // ======== Alt Benzerlik Skorları ========
    const levenshteinScore = (() => {
        const matrix = [];
        if (cleanedSearchName.length === 0) return cleanedHitName.length === 0 ? 1.0 : 0.0;
        if (cleanedHitName.length === 0) return cleanedSearchName.length === 0 ? 1.0 : 0.0;
    
        for (let i = 0; i <= cleanedHitName.length; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= cleanedSearchName.length; j++) {
            matrix[0][j] = j;
        }
    
        for (let i = 1; i <= cleanedHitName.length; i++) {
            for (let j = 1; j <= cleanedSearchName.length; j++) {
                const cost = cleanedHitName.charAt(i - 1) === cleanedSearchName.charAt(j - 1) ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + cost, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
        const maxLength = Math.max(cleanedSearchName.length, cleanedHitName.length);
        return maxLength === 0 ? 1.0 : 1.0 - (matrix[cleanedHitName.length][cleanedSearchName.length] / maxLength);
    })();
    // Log satırı kaldırıldı

    const jaroWinklerScore = (() => {
        const s1 = cleanedSearchName;
        const s2 = cleanedHitName;
        if (s1 === s2) return 1.0;

        let m = 0;
        const s1_len = s1.length;
        const s2_len = s2.length;

        const range = Math.floor(Math.max(s1_len, s2_len) / 2) - 1;
        const s1_matches = new Array(s1_len);
        const s2_matches = new Array(s2_len);

        for (let i = 0; i < s1_len; i++) {
            const char_s1 = s1[i];
            for (let j = Math.max(0, i - range); j < Math.min(s2_len, i + range + 1); j++) {
                if (char_s1 === s2[j] && !s2_matches[j]) {
                    s1_matches[i] = true;
                    s2_matches[j] = true;
                    m++;
                    break;
                }
            }
        }

        if (m === 0) return 0.0;

        let k = 0;
        let t = 0;
        for (let i = 0; i < s1_len; i++) {
            if (s1_matches[i]) {
                let j;
                for (j = k; j < s2_len; j++) {
                    if (s2_matches[j]) {
                        k = j + 1;
                        break;
                    }
                }
                if (s1[i] !== s2[j]) {
                    t++;
                }
            }
        }
        t = t / 2;

        const jaro_score = (m / s1_len + m / s2_len + (m - t) / m) / 3;

        const p = 0.1;
        let l = 0;
        const max_prefix_len = 4;

        for (let i = 0; i < Math.min(s1_len, s2_len, max_prefix_len); i++) {
            if (s1[i] === s2[i]) {
                l++;
            } else {
                break;
            }
        }

        return jaro_score + l * p * (1 - jaro_score);
    })();
    // Log satırı kaldırıldı

    const ngramScore = (() => {
        const s1 = cleanedSearchName;
        const s2 = cleanedHitName;
        const n = 2;
        if (!s1 || !s2) return 0.0;
        if (s1 === s2) return 1.0;

        const getNGrams = (s, num) => {
            const ngrams = new Set();
            for (let i = 0; i <= s.length - num; i++) {
                ngrams.add(s.substring(i, i + num));
            }
            return ngrams;
        };

        const ngrams1 = getNGrams(s1, n);
        const ngrams2 = getNGrams(s2, n);

        if (ngrams1.size === 0 && ngrams2.size === 0) return 1.0;
        if (ngrams1.size === 0 || ngrams2.size === 0) return 0.0;

        let common = 0;
        ngrams1.forEach(ngram => {
            if (ngrams2.has(ngram)) {
                common++;
            }
        });

        return common / Math.min(ngrams1.size, ngrams2.size);
    })();
    // Log satırı kaldırıldı

    const visualScore = (() => {
        const visualPenalty = visualMismatchPenalty(cleanedSearchName, cleanedHitName);
        const maxPossibleVisualPenalty = Math.max(cleanedSearchName.length, cleanedHitName.length) * 1.0;
        return maxPossibleVisualPenalty === 0 ? 1.0 : (1.0 - (visualPenalty / maxPossibleVisualPenalty));
    })();
    // Log satırı kaldırıldı

    const prefixScore = (() => {
        const s1 = cleanedSearchName;
        const s2 = cleanedHitName;
        const length = 3;
        if (!s1 || !s2) return 0.0;
        const prefix1 = s1.substring(0, Math.min(s1.length, length));
        const prefix2 = s2.substring(0, Math.min(s2.length, length));

        if (prefix1 === prefix2) return 1.0;
        if (prefix1.length === 0 && prefix2.length === 0) return 1.0;

        return levenshteinSimilarity(prefix1, prefix2); 
    })();
    // Log satırı kaldırıldı

    // 6. Kelime Bazında En Yüksek Benzerlik Skoru + Eşleşen Kelime Çifti
    const { maxWordScore, maxWordPair } = (() => {
        const s1 = cleanedSearchName;
        const s2 = cleanedHitName;
        if (!s1 || !s2) return { maxWordScore: 0.0, maxWordPair: null };

        const words1 = s1.split(' ').filter(w => w.length > 0);
        const words2 = s2.split(' ').filter(w => w.length > 0);

        if (words1.length === 0 && words2.length === 0) return { maxWordScore: 1.0, maxWordPair: null };
        if (words1.length === 0 || words2.length === 0) return { maxWordScore: 0.0, maxWordPair: null };

        let maxSim = 0.0;
        let pair = null;
        for (const w1 of words1) {
            for (const w2 of words2) {
                const sim = levenshteinSimilarity(w1, w2);
                if (sim > maxSim) {
                    maxSim = sim;
                    pair = [w1, w2];
                }
            }
        }
        return { maxWordScore: maxSim, maxWordPair: pair };
    })();

    // Log satırı kaldırıldı

    // Yeni: Konumsal Tam Eşleşme Skoru (örn: ilk 3 karakter tam eşleşiyorsa)
    const positionalExactMatchScore = (() => {
        const s1 = cleanedSearchName;
        const s2 = cleanedHitName;
        if (!s1 || !s2) return 0.0;

        // İlk 3 karakteri büyük/küçük harf duyarsız karşılaştır
        const len = Math.min(s1.length, s2.length, 3);
        if (len === 0) return 0.0; // Karşılaştırılacak karakter yok

        // Tüm karakterleri kontrol et - HEPSİ eşleşmeli
        for (let i = 0; i < len; i++) {
            if (s1[i] !== s2[i]) {  
                return 0.0;          
            }
        }
        return 1.0; 
    })();
    // Log satırı kaldırıldı

    // ======== YENİ KURAL: Yüksek Kelime Benzerliği Kontrolü ve Önceliklendirme ========

    const HIGH_WORD_SIMILARITY_THRESHOLD = 0.70;

    // Eşleşen en iyi kelime çifti tam eşleşmeyse uzunluğunu kontrol et
    const exactWordLen =
        (maxWordPair && maxWordPair[0] === maxWordPair[1]) ? maxWordPair[0].length : 0;

    if (maxWordScore >= HIGH_WORD_SIMILARITY_THRESHOLD) {
        // Eğer tam kelime eşleşmesi ile 1.0 elde edildiyse ve bu kelime 2 karakterden kısaysa
        // erken dönüşü engelle (tek harfli "a" gibi durumlar %100 yapmasın)
        if (maxWordScore === 1.0 && exactWordLen < 2) {
            // Log satırı kaldırıldı
            // Erken dönme, alttaki karma skorlamaya devam
        } else {
            // Log satırı kaldırıldı
            return { finalScore: maxWordScore, positionalExactMatchScore: positionalExactMatchScore };
        }
    }
    
    // ======== İsim Benzerliği Alt Toplamı Hesaplama (%95 Ağırlık) ========
    const nameSimilarityRaw = (
        levenshteinScore * 0.30 +
        jaroWinklerScore * 0.25 +
        ngramScore * 0.15 +
        visualScore * 0.15 +
        prefixScore * 0.10 +
        maxWordScore * 0.05
    );

    const nameSimilarityWeighted = nameSimilarityRaw * 0.95;
    // Log satırı kaldırıldı

    // ======== Fonetik Benzerlik Skoru (%5 Ağırlık) ========
    const phoneticScoreRaw = isPhoneticallySimilar(searchMarkName, hitMarkName);
    const phoneticSimilarityWeighted = phoneticScoreRaw * 0.05;
    // Log satırı kaldırıldı

    // ======== Genel Benzerlik Skoru ========
    let finalScore = nameSimilarityWeighted + phoneticSimilarityWeighted;

    finalScore = Math.max(0.0, Math.min(1.0, finalScore));

    // Log satırı kaldırıldı
    return { finalScore: finalScore, positionalExactMatchScore: positionalExactMatchScore }; 
}

// ======== Sunucu Tarafında Marka Benzerliği Araması (GÜNCEL BAŞLATICI) ========
export const performTrademarkSimilaritySearch = onCall(
  {
    region: 'europe-west1',
    timeoutSeconds: 540,
    memory: '1GiB', 
  },
  async (request) => {
    const { monitoredMarks, selectedBulletinId, async = false, jobId } = request.data;

    // Parametre Kontrolü
    if (!Array.isArray(monitoredMarks) || monitoredMarks.length === 0 || !selectedBulletinId) {
      throw new HttpsError(
        'invalid-argument',
        'Eksik parametre: monitoredMarks (dizi) veya selectedBulletinId gerekli.'
      );
    }

    // =========================
    // ASYNC MODE: İşi Parçala ve Workerlara Dağıt
    // =========================
    if (async) {
      const currentJobId = jobId || `search_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const WORKER_COUNT = 10; 

      logger.info(`🚀 Arama Başlatılıyor: JobID=${currentJobId}, Marka Sayısı=${monitoredMarks.length}`);

      // 1. Ana İş Kaydını Oluştur
      await adminDb.collection('searchProgress').doc(currentJobId).set({
        status: 'queued',
        progress: 0,
        total: monitoredMarks.length,
        processed: 0,
        currentResults: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        bulletinId: selectedBulletinId,
        totalChunks: WORKER_COUNT
      });

      // 2. Markaları Eşit Parçalara Böl
      const batchSize = Math.ceil(monitoredMarks.length / WORKER_COUNT);
      const promises = [];
      const TOPIC_NAME = 'similarity-search-jobs';
      
      try { await ensureTopic(TOPIC_NAME); } catch(e) {}

      for (let i = 0; i < WORKER_COUNT; i++) {
        const start = i * batchSize;
        const end = start + batchSize;
        const markChunk = monitoredMarks.slice(start, end);

        if (markChunk.length === 0) continue;

        const messagePayload = {
          jobId: currentJobId,
          workerId: i + 1,
          monitoredMarks: markChunk,
          selectedBulletinId: selectedBulletinId,
          startIndex: 0
        };

        const p = pubsubClient.topic(TOPIC_NAME).publishMessage({
          json: messagePayload
        });
        promises.push(p);
      }

      await Promise.all(promises);
      
      // YENİ: Başarıyla oluşturulan gerçek worker sayısını Firestore'da güncelle
      await adminDb.collection('searchProgress').doc(currentJobId).update({
          totalChunks: promises.length
      });
      
      logger.info(`✅ ${promises.length} adet Worker tetiklendi ve Firestore güncellendi.`);

      return { 
          success: true, 
          jobId: currentJobId, 
          async: true, 
          workerCount: promises.length,
          message: "Arama işlemi arka planda başlatıldı."
      };
    }

    return { success: false, error: "Lütfen 'async: true' parametresini kullanın." };
  }
);

// 🔥 YENİ: Nice Sınıfları Arası Çapraz İlişki (Akrabalık) Haritası
const RELATED_CLASSES_MAP = {
    "29": ["30", "31", "43"], "30": ["29", "31", "43"], "31": ["29", "30", "43"],
    "32": ["33"], "33": ["32"], "43": ["29", "30", "31"],
    "1": ["5"], "3": ["5", "44"], "5": ["1", "3", "10", "44"],
    "10": ["5", "44"], "44": ["3", "5", "10"],
    "18": ["25"], "23": ["24", "25"], "24": ["20", "23", "25", "27", "35"],
    "25": ["18", "23", "24", "26"], "26": ["25"],
    "9": ["28", "38", "41", "42"], "28": ["9", "41"], "38": ["9"],
    "41": ["9", "16", "28", "42"], "42": ["9", "41"], "16": ["41"],
    "7": ["37"], "11": ["21", "37"], "12": ["37", "39"],
    "37": ["7", "11", "12", "19", "36"], "39": ["12", "36"],
    "6": ["19", "20"], "19": ["6", "35", "37"], "20": ["6", "21", "24", "27", "35"],
    "21": ["11", "20"], "27": ["20", "24", "35"], "35": ["19", "20", "24", "27", "36"],
    "36": ["35", "37", "39"]
};

async function processSearchInBackground(jobId, monitoredMarks, selectedBulletinId, startIndex = 0, workerId = '1') {
  
  const mainJobRef = adminDb.collection('searchProgress').doc(jobId);
  const workerProgressRef = mainJobRef.collection('workers').doc(String(workerId));

  const TIMEOUT_LIMIT = 480 * 1000; 
  const startTime = Date.now();
  
  let pendingResults = [];
  let totalFoundCount = 0; 
  
  if (startIndex > 0) {
      const snap = await workerProgressRef.get();
      if (snap.exists) {
          totalFoundCount = snap.data().found || 0;
      }
  }

  const WRITE_BATCH_SIZE = 300; 

  const publishSafely = async (results) => {
      if (results.length === 0) return;
      const payload = { json: { jobId, results } };
      try {
          await pubsubClient.topic('save-search-results').publishMessage(payload);
          await new Promise(r => setTimeout(r, 200)); 
      } catch (err) {
          logger.warn(`⚠️ Pub/Sub hatası (Worker ${workerId}), tekrar deneniyor...`);
          await new Promise(r => setTimeout(r, 1000));
          try {
              await pubsubClient.topic('save-search-results').publishMessage(payload);
          } catch (retryErr) {
              try {
                  const batch = adminDb.batch();
                  const col = mainJobRef.collection('foundResults');
                  results.forEach(r => batch.set(col.doc(), r));
                  batch.update(mainJobRef, {
                      currentResults: admin.firestore.FieldValue.increment(results.length),
                      lastUpdate: admin.firestore.FieldValue.serverTimestamp()
                  });
                  await batch.commit();
              } catch(e) { logger.error("Firestore Fallback Hatası:", e); }
          }
      }
  };

  try {
    const bucket = admin.storage().bucket();
    let bulletinNo = selectedBulletinId.includes('_') ? selectedBulletinId.split('_')[0] : selectedBulletinId;
    const indexFilePath = `bulletins/${bulletinNo}_index.json`;
    const indexFile = bucket.file(indexFilePath);

    const [exists] = await indexFile.exists();
    if (!exists) throw new Error(`İndeks dosyası bulunamadı.`);

    const [metadata] = await indexFile.getMetadata();
    const totalBytes = parseInt(metadata.size, 10) || 1; 

    if (startIndex === 0) {
        workerProgressRef.set({ 
            status: 'processing', progress: 0, processed: 0, found: 0, total: totalBytes, 
            lastUpdate: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(()=>{});
        logger.info(`✅ Worker ${workerId} başladı (Batch: 300).`);
    } else {
        logger.info(`🔄 Worker ${workerId} satır ${startIndex}'den devam ediyor (Mevcut: ${totalFoundCount})...`);
    }

const preparedMonitoredMarks = monitoredMarks.map(mark => {
        const originalName = (mark.markName || mark.title || '').trim();
        const overrideName = (mark.searchMarkName || '').trim();
        const primaryName = (overrideName || originalName).trim();
        let alternatives = Array.isArray(mark.brandTextSearch) ? mark.brandTextSearch : [];
        const searchTerms = [primaryName, ...alternatives]
            .filter(t => t && t.trim().length > 0)
            .map(term => ({ term, cleanedSearchName: cleanMarkName(term, term.trim().split(/\s+/).length > 1) }));

        // 🔥 YENİ: Sınıf Havuzlarını Hazırla
        const originalClassesRaw = Array.isArray(mark.goodsAndServicesByClass)
            ? mark.goodsAndServicesByClass.map(c => String(c.classNo || c))
            : (Array.isArray(mark.niceClasses) ? mark.niceClasses.map(String) : []);
        const watchedClassesRaw = Array.isArray(mark.niceClassSearch) ? mark.niceClassSearch.map(String) : [];

        const greenSet = new Set(originalClassesRaw.map(c => c.replace(/\D/g, '')).filter(Boolean));
        const orangeSet = new Set(watchedClassesRaw.map(c => c.replace(/\D/g, '')).filter(Boolean));
        const blueSet = new Set();

        // Mavi (Akraba) Havuzu Doldur
        greenSet.forEach(c => {
            if (RELATED_CLASSES_MAP[c]) RELATED_CLASSES_MAP[c].forEach(rel => blueSet.add(rel));
        });

        // Çakışmaları Engelle
        greenSet.forEach(c => { orangeSet.delete(c); blueSet.delete(c); });
        orangeSet.forEach(c => blueSet.delete(c));

        return { 
            ...mark, primaryName, searchTerms, 
            applicationDate: mark.applicationDate || null, 
            niceClasses: mark.niceClassSearch || mark.niceClasses || [],
            greenSet, orangeSet, blueSet // Sepetleri objeye ekle
        };
    });

    const fileStream = indexFile.createReadStream();
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let currentLineIndex = 0;
    let processedCount = startIndex;
    let processedBytes = 0;

    for await (const line of rl) {
        if (Date.now() - startTime > TIMEOUT_LIMIT) {
            const passedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
            logger.warn(`⚠️ SÜRE DOLDU (${passedSeconds}s). Worker ${workerId} devrediliyor.`);
            if (pendingResults.length > 0) await publishSafely(pendingResults);
            await workerProgressRef.set({ status: 'resuming', nextIndex: currentLineIndex, found: totalFoundCount }, { merge: true });
            const nextPayload = { jobId, monitoredMarks, selectedBulletinId, workerId, startIndex: currentLineIndex };
            await pubsubClient.topic('similarity-search-jobs').publishMessage({ json: nextPayload });
            rl.close(); fileStream.destroy();
            return;
        }

        processedBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (currentLineIndex < startIndex) { currentLineIndex++; continue; }

        if (currentLineIndex % 500 === 0) {
             const progressPercent = Math.min(100, Math.floor((processedBytes / totalBytes) * 100));
             workerProgressRef.set({ 
                processed: processedCount, progress: progressPercent, found: totalFoundCount, 
                lastUpdate: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(()=>{});
        }

        let hit;
        try {
            if(!line.trim()) continue;
            hit = JSON.parse(line);
            if (!hit.markName && hit.o) { 
                hit.markName = hit.o; hit.cleanName = hit.n; hit.applicationNo = hit.an;
                hit.applicationDate = hit.d; hit.niceClasses = hit.c; hit.id = hit.id;
                hit.imagePath = hit.i; hit.bulletinId = selectedBulletinId;
            }
        } catch (e) { currentLineIndex++; continue; }

        // Bültendeki markanın sınıflarını güvenli bir diziye çevir
        let rawHitClasses = [];
        if (Array.isArray(hit.niceClasses)) rawHitClasses = hit.niceClasses;
        else if (typeof hit.niceClasses === 'string') rawHitClasses = hit.niceClasses.split(/[^\d]+/);
        const hitClasses = rawHitClasses.map(c => String(c).replace(/\D/g, '')).filter(Boolean);

        for (const monitoredMark of preparedMonitoredMarks) {
             if (!isValidBasedOnDate(hit.applicationDate, monitoredMark.applicationDate)) continue;

             for (const searchItem of monitoredMark.searchTerms) {
                // 1. İstisna Kontrolü
                const cleanedHitName = hit.cleanName || cleanMarkName(hit.markName);
                let isPrefixSuffixExactMatch = false;
                if (searchItem.cleanedSearchName.length >= 3 && cleanedHitName.includes(searchItem.cleanedSearchName)) {
                    isPrefixSuffixExactMatch = true;
                }

                // 🔥 2. Havuz (Sepet) Kontrolü ve Renk Ataması
                let hasPoolMatch = false;
                let classColors = {};

                for (const hc of hitClasses) {
                    if (monitoredMark.greenSet.has(hc)) { hasPoolMatch = true; classColors[hc] = 'green'; }
                    else if (monitoredMark.orangeSet.has(hc)) { hasPoolMatch = true; classColors[hc] = 'orange'; }
                    else if (monitoredMark.blueSet.has(hc)) { hasPoolMatch = true; classColors[hc] = 'blue'; }
                    else { classColors[hc] = 'gray'; } // Havuz dışı (Alakasız)
                }

                // 🔥 3. ERKEN ÇIKIŞ (Performans patlaması - Alakasız olanı hiç hesaplama)
                if (!hasPoolMatch && !isPrefixSuffixExactMatch) {
                    continue; 
                }

                const { finalScore, positionalExactMatchScore } = calculateSimilarityScoreInternal(
                  hit.markName, searchItem.term, hit.applicationDate, monitoredMark.applicationDate, hit.niceClasses, monitoredMark.niceClasses
                );

                const SIMILARITY_THRESHOLD = 0.5;
                if (finalScore < SIMILARITY_THRESHOLD && positionalExactMatchScore < SIMILARITY_THRESHOLD && !isPrefixSuffixExactMatch) continue;

                pendingResults.push({
                  objectID: hit.id, markName: hit.markName, applicationNo: hit.applicationNo,
                  applicationDate: hit.applicationDate, niceClasses: hit.niceClasses, holders: hit.holders || [],      
                  imagePath: hit.imagePath || null, bulletinId: hit.bulletinId, similarityScore: finalScore,
                  positionalExactMatchScore, monitoredTrademark: monitoredMark.primaryName, matchedTerm: searchItem.term,
                  monitoredTrademarkId: monitoredMark.id, monitoredMarkId: monitoredMark.id, isEarlier: false,
                  classColors // 🔥 Renk kodlarını Frontend'e ilet
                });
             }
        }

        if (pendingResults.length >= WRITE_BATCH_SIZE) {
            totalFoundCount += pendingResults.length; 
            await publishSafely(pendingResults);
            pendingResults = []; 
        }
        currentLineIndex++;
        processedCount++;
    } 

    if (pendingResults.length > 0) {
        totalFoundCount += pendingResults.length;
        await publishSafely(pendingResults);
    }

    await workerProgressRef.set({
      status: 'completed', progress: 100, processed: processedCount, 
      found: totalFoundCount, completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    logger.info(`✅ Worker ${workerId} bitti. Bulunan: ${totalFoundCount}`);

  } catch (error) {
      logger.error(`❌ Worker ${workerId} hatası:`, error);
      await workerProgressRef.set({ status: 'error', error: error.message }, { merge: true });
  }
}


const bucket = admin.storage().bucket();
export const generateSimilarityReport = onCall(
  {
    timeoutSeconds: 540,
    memory: "1GiB",
    region: "europe-west1"
  },
  async (request) => {
    logger.log("🚀 [WATCH-NOTICE] generateSimilarityReport BAŞLADI.");
    try {
      const { results, bulletinNo } = request.data;
      if (!results || !Array.isArray(results)) throw new Error("Geçersiz veri formatı");

      const owners = {};
      results.forEach((m) => {
        const ownerName = (m.monitoredMark && m.monitoredMark.ownerName) || "Bilinmeyen Sahip";
        if (!owners[ownerName]) owners[ownerName] = [];
        owners[ownerName].push(m);
      });

      const globalArchive = archiver("zip", { zlib: { level: 9 } });
      const passthrough = new stream.PassThrough();
      globalArchive.pipe(passthrough);

      for (const [ownerNameKey, matches] of Object.entries(owners)) {
        // 1. Raporu Oluştur (docBuffer)
        const doc = await createProfessionalReport(ownerNameKey, matches);
        const docBuffer = await Packer.toBuffer(doc);
        globalArchive.append(docBuffer, { name: `${sanitizeFileName(ownerNameKey)}_Benzerlik_Raporu.docx` });

        const targetClientId = matches[0]?.monitoredMark?.clientId;
        
        if (targetClientId && bulletinNo) {
          try {
            // Mükerrer Kontrolü
            const existing = await adminDb.collection("mail_notifications")
              .where("clientId", "==", targetClientId)
              .where("bulletinNo", "==", String(bulletinNo))
              .where("source", "==", "bulletin_watch_system")
              .limit(1).get();

            if (!existing.empty) continue;

            // Müvekkil Adı Çözümleme
            let displayClientName = ownerNameKey;
            const personDoc = await adminDb.collection("persons").doc(targetClientId).get();
            if (personDoc.exists) {
              displayClientName = personDoc.data().name || personDoc.data().companyName || displayClientName;
            }

            // [STORAGE GÜNCELLEME] WORD OLARAK KAYDET VE URL OLUŞTUR
            const reportFileName = `${bulletinNo}_${sanitizeFileName(displayClientName)}_Izleme_Raporu.docx`;
            const storagePath = `bulletin_reports/${bulletinNo}/${targetClientId}/${Date.now()}_${reportFileName}`;
            const file = admin.storage().bucket().file(storagePath);

            const token = uuidv4();

            await file.save(docBuffer, {
              contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              metadata: {
                metadata: {
                  firebaseStorageDownloadTokens: token,
                },
              },
            });

            const downloadURL =
              `https://firebasestorage.googleapis.com/v0/b/${admin.storage().bucket().name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;


            // Şablon ve Replacements... (Aynı kalıyor)
            let objectionDeadline = "-"; // (Yukarıdaki tarih hesaplama mantığı burada da kullanılabilir)
            const bDateStr = matches[0]?.similarMark?.bulletinDate || matches[0]?.similarMark?.applicationDate;
            if (bDateStr) {
                const parts = bDateStr.split(/[./-]/);
                const bDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
                if (!isNaN(bDate.getTime())) {
                    const rawDue = addMonthsToDate(bDate, 2);
                    const adjustedDue = findNextWorkingDay(rawDue, TURKEY_HOLIDAYS, { isWeekend, isHoliday });
                    objectionDeadline = `${String(adjustedDue.getDate()).padStart(2, '0')}.${String(adjustedDue.getMonth() + 1).padStart(2, '0')}.${adjustedDue.getFullYear()}`;
                }
            }

            const replacements = { "{{bulletinNo}}": String(bulletinNo), "{{muvekkil_adi}}": displayClientName, "{{objection_deadline}}": objectionDeadline };
            const templateSnap = await adminDb.collection("mail_templates").doc("tmpl_watchnotice").get();
            let subject = `${bulletinNo} Sayılı Bülten İzleme Raporu`;
            let body = `<p>Raporunuz ekte sunulmuştur.</p>`;
            if (templateSnap.exists) {
                const tmpl = templateSnap.data();
                subject = tmpl.subject || subject; body = tmpl.body || body;
                for (const [key, val] of Object.entries(replacements)) {
                    subject = subject.split(key).join(val); body = body.split(key).join(val);
                }
            }

            const recipients = await getRecipientsByApplicantIds([{ id: targetClientId }], "marka");

            // Eğer CC boşsa evrekaMailCCList'ten ekle
            let ccList = recipients.cc || [];
            if (ccList.length === 0) {
              const extraCC = await getCcFromEvrekaListByTransactionType("marka");
              ccList = extraCC || [];
            }

            // [FIRESTORE GÜNCELLEME] Temiz Yapı
            await adminDb.collection("mail_notifications").add({
              clientId: targetClientId,
              applicantName: displayClientName,
              bulletinNo: String(bulletinNo),
              objectionDeadline: objectionDeadline,
              toList: recipients.to || [],
              ccList: recipients.cc || [],
              subject,
              body,
              status: "awaiting_client_approval",
              mode: "draft",
              isDraft: true,
              notificationType: "marka",
              source: "bulletin_watch_system",
              assignedTo_uid: selcanUserId,
              assignedTo_email: selcanUserEmail,
              
              // 1. Mail gönderici fonksiyonun (Nodemailer) eki görebilmesi için:
              taskAttachments: [{
                name: reportFileName,
                storagePath: storagePath,
                url: downloadURL
              }],
              
              // 2. Arayüzde (UI) dosyanın indirilebilir görünmesi için (signedUrl hatası düzeltildi):
              files: [{ 
                fileName: reportFileName, 
                storagePath: storagePath, 
                url: downloadURL 
              }],
              
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

          } catch (loopErr) { logger.error(`❌ [LOOP-ERROR]:`, loopErr); }
        }
      }

      await globalArchive.finalize();
      const chunks = [];
      for await (const chunk of passthrough) chunks.push(chunk);
      return { success: true, file: Buffer.concat(chunks).toString("base64") };

    } catch (error) {
      logger.error("💥 [FATAL-ERROR]:", error);
      return { success: false, error: error.message };
    }
  }
);

// Ana rapor oluşturma fonksiyonu
async function createProfessionalReport(ownerName, matches) {
  // --- Benzer marka bazında grupla ---
  const grouped = {};
  matches.forEach((m) => {
    const key = (m.similarMark && m.similarMark.applicationNo) || 'unknown';
    if (!grouped[key]) {
      grouped[key] = { 
        similarMark: m.similarMark || {}, 
        monitoredMarks: [] 
      };
    }
    grouped[key].monitoredMarks.push(m.monitoredMark || {});
  });

  const reportContent = [];

  // Her benzer marka için ayrı sayfa (async)
  for (const [index, [_, group]] of Object.entries(grouped).entries()) {
    if (index > 0) {
      reportContent.push(new Paragraph({ children: [new PageBreak()] }));
    }
    const pageElements = await createComparisonPage(group);
    reportContent.push(...pageElements);
  }

  return new Document({
    creator: "IPGate-EVREKA GROUP",
    description: `${ownerName} Marka Benzerlik Raporu`,
    title: `Marka Benzerlik Raporu`,
    sections: [{
      properties: {},
      children: reportContent
    }]
  });
}

// Firebase Storage'dan veya HTTP URL'den görsel indir
async function downloadImageAsBuffer(imagePath) {
  if (!imagePath) return null;
  
  try {
    // HTTP URL ise direkt indir
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      console.log(`📥 HTTP'den görsel indiriliyor: ${imagePath}`);
      const response = await fetch(imagePath);
      if (!response.ok) {
        console.warn(`⚠️ HTTP indirme hatası: ${response.status} ${response.statusText}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log(`✅ HTTP'den görsel indirildi: ${imagePath} (${buffer.length} bytes)`);
      return buffer;
    }
    
    // Storage path ise Firebase Storage'dan indir
    const bucket = admin.storage().bucket();
    const file = bucket.file(imagePath);
    
    const [exists] = await file.exists();
    if (!exists) {
      console.warn(`⚠️ Storage'da görsel bulunamadı: ${imagePath}`);
      return null;
    }
    
    const [buffer] = await file.download();
    console.log(`✅ Storage'dan görsel indirildi: ${imagePath} (${buffer.length} bytes)`);
    return buffer;
  } catch (error) {
    console.error(`❌ Görsel indirme hatası (${imagePath}):`, error.message);
    return null;
  }
}

// Profesyonel Karşılaştırma Raporu (MODERN MAVİ - 9 PUNTO & BOLD REVİZE)
async function createComparisonPage(group) {
  const similarMark = group.similarMark;
  const monitoredMarks = group.monitoredMarks || [];
  const monitoredMark = monitoredMarks.length > 0 ? monitoredMarks[0] : {};
  
  const elements = [];
  const tableRows = [];
  
  const FONT_FAMILY = "Montserrat";
  const GLOBAL_FONT_SIZE = 18; // 9 Punto
  
  const COLORS = {
    CLIENT_HEADER: "1E40AF",    // Müvekkil (Safir Mavi)
    SIMILAR_HEADER: "64748B",   // Benzer (Platin Gri)
    TEXT_DARK: "1E293B",        // Genel Metin
    NICE_BG: "F1F5F9",          // Nice Sınıf Arka Plan
    BORDER_LIGHT: "E2E8F0",     // Kenarlıklar
    DEADLINE_BG: "DBEAFE",      // Alt Panel Arka Plan (Açık Mavi)
    DEADLINE_TEXT: "1E40AF",    // Koyu Mavi Yazı
    EXPERT_BG: "F8FAFC",        // Uzman Görüşü Arka Plan
    EXPERT_BORDER: "1E40AF"     // Uzman Görüşü Kenarlık
  };

// ============ İTİRAZ SON TARİHİ HESAPLA ============
  let objectionDeadline = "-";
  try {
    const bulletinDateStr = similarMark.bulletinDate || similarMark.applicationDate;
    if (bulletinDateStr) {
      let bulletinDate = null;
      const parts = bulletinDateStr.split(/[./-]/);
      if (parts.length === 3) {
          // YYYY-MM-DD veya DD.MM.YYYY tespiti (Zaman dilimi kaymasını önler)
          if (parts[0].length === 4) {
             bulletinDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          } else {
             bulletinDate = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
          }
      } else {
          bulletinDate = new Date(bulletinDateStr);
      }
      
      if (bulletinDate && !isNaN(bulletinDate.getTime())) {
        let targetDate = new Date(bulletinDate);
        targetDate.setMonth(targetDate.getMonth() + 2); // Tam 2 ay ekle
        
        let iter = 0;
        // Tatil veya haftasonuna denk gelirse bir sonraki iş gününe at (Maksimum 30 gün ileri sarabilir)
        while ((isWeekend(targetDate) || isHoliday(targetDate, TURKEY_HOLIDAYS)) && iter < 30) {
            targetDate.setDate(targetDate.getDate() + 1);
            iter++;
        }
        objectionDeadline = `${String(targetDate.getDate()).padStart(2, '0')}.${String(targetDate.getMonth() + 1).padStart(2, '0')}.${targetDate.getFullYear()}`;
      }
    }
  } catch (e) { console.error("Deadline error:", e); }

  // ============ GÖRSELLERİ İNDİR ============
  let monitoredImageBuffer = null;
  let similarImageBuffer = null;
  if (monitoredMark.imagePath) monitoredImageBuffer = await downloadImageAsBuffer(monitoredMark.imagePath);
  if (similarMark.imagePath) similarImageBuffer = await downloadImageAsBuffer(similarMark.imagePath);

  // ============ 1. BAŞLIK SATIRI ============
  tableRows.push(
    new TableRow({
      height: { value: 400, rule: "atLeast" },
      children: [
        new TableCell({
          width: { size: 50, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({
              children: [ new TextRun({ text: "MÜVEKKİL MARKASI", bold: true, size: GLOBAL_FONT_SIZE, color: "FFFFFF", font: FONT_FAMILY }) ],
              alignment: AlignmentType.CENTER, spacing: { before: 100, after: 50 }
            }),
            new Paragraph({
              children: [ new TextRun({ text: "(İZLENEN)", size: 14, color: "FFFFFF", italics: true, font: FONT_FAMILY }) ],
              alignment: AlignmentType.CENTER, spacing: { after: 100 }
            })
          ],
          shading: { fill: COLORS.CLIENT_HEADER }, verticalAlign: "center",
          borders: { right: { style: "single", size: 6, color: "FFFFFF" } }
        }),
        new TableCell({
          width: { size: 50, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({
              children: [ new TextRun({ text: "BENZER MARKA", bold: true, size: GLOBAL_FONT_SIZE, color: "FFFFFF", font: FONT_FAMILY }) ],
              alignment: AlignmentType.CENTER, spacing: { before: 100, after: 50 }
            }),
            new Paragraph({
              children: [ new TextRun({ text: "(BÜLTEN)", size: 14, color: "FFFFFF", italics: true, font: FONT_FAMILY }) ],
              alignment: AlignmentType.CENTER, spacing: { after: 100 }
            })
          ],
          shading: { fill: COLORS.SIMILAR_HEADER }, verticalAlign: "center"
        })
      ]
    })
  );

  // ============ 2. GÖRSEL ALANLARI (İSİMLER KALDIRILDI) ============
  const createVisualCell = (imageBuffer) => {
    const content = [];
    if (imageBuffer) {
        try {
            content.push(new Paragraph({
                children: [ new ImageRun({ data: imageBuffer, transformation: { width: 160, height: 160 } }) ],
                alignment: AlignmentType.CENTER, spacing: { before: 150, after: 150 }
            }));
        } catch (e) { }
    } else {
        content.push(new Paragraph({
            children: [ new TextRun({ text: "(Görsel Yok)", size: GLOBAL_FONT_SIZE, color: "94A3B8", italics: true, font: FONT_FAMILY }) ],
            alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 }
        }));
    }
    return new TableCell({ 
        children: content, verticalAlign: "center", shading: { fill: "FFFFFF" },
        borders: { bottom: { style: "single", size: 4, color: COLORS.BORDER_LIGHT } }
    });
  };

  tableRows.push(new TableRow({ children: [createVisualCell(monitoredImageBuffer), createVisualCell(similarImageBuffer)] }));

  // ============ 3. VERİ SATIRLARI (9 PUNTO) ============
  const createInfoRow = (label, val1, val2, bgColor = "FFFFFF") => {
    return new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({ children: [ new TextRun({ text: label, bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.SIMILAR_HEADER, font: FONT_FAMILY }) ], spacing: { before: 80, after: 40 } }),
            new Paragraph({ children: [ new TextRun({ text: val1 || "-", size: GLOBAL_FONT_SIZE, color: COLORS.TEXT_DARK, font: FONT_FAMILY }) ], spacing: { after: 80 } })
          ],
          shading: { fill: bgColor }, margins: { left: 120 }, verticalAlign: "center",
          borders: { right: { style: "single", size: 2, color: COLORS.BORDER_LIGHT } }
        }),
        new TableCell({
          children: [
            new Paragraph({ children: [ new TextRun({ text: label, bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.SIMILAR_HEADER, font: FONT_FAMILY }) ], spacing: { before: 80, after: 40 } }),
            new Paragraph({ children: [ new TextRun({ text: val2 || "-", size: GLOBAL_FONT_SIZE, color: COLORS.TEXT_DARK, font: FONT_FAMILY }) ], spacing: { after: 80 } })
          ],
          shading: { fill: bgColor }, margins: { left: 120 }, verticalAlign: "center"
        })
      ]
    });
  };

  const formatNiceClasses = (classes) => {
    if (!classes || classes.length === 0) return "-";
    const classArray = Array.isArray(classes) ? classes : String(classes).split(',').map(s => s.trim());
    return classArray.map(c => `[${c}]`).join(" ");
  };

  tableRows.push(createInfoRow("Nice Sınıfları", formatNiceClasses(monitoredMark.niceClasses), formatNiceClasses(similarMark.niceClasses), COLORS.NICE_BG));
  tableRows.push(createInfoRow("Başvuru No", monitoredMark.applicationNo, similarMark.applicationNo));
  tableRows.push(createInfoRow("Başvuru Tarihi", monitoredMark.applicationDate, similarMark.applicationDate, "FAFAFA"));
  tableRows.push(createInfoRow("Sahip", monitoredMark.ownerName, similarMark.ownerName));

  // ============ 4. SON TARİH VE BAŞARI ŞANSI (BOLD & MAVİ) ============
  const successChance = similarMark.bs || ""; 
  tableRows.push(
    new TableRow({
      height: { value: 600, rule: "atLeast" },
      children: [
        new TableCell({
          children: [
            new Paragraph({
              children: [ new TextRun({ text: "İTİRAZ İÇİN SON TARİH", size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY }) ],
              alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }
            }),
            new Paragraph({
              children: [ new TextRun({ text: objectionDeadline, bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY }) ],
              alignment: AlignmentType.CENTER, spacing: { after: 120 }
            })
          ],
          shading: { fill: COLORS.DEADLINE_BG }, verticalAlign: "center",
          borders: { top: { style: "single", size: 8, color: COLORS.CLIENT_HEADER }, right: { style: "single", size: 4, color: "FFFFFF" } }
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [ new TextRun({ text: "İTİRAZ BAŞARI ŞANSI", size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY }) ],
              alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }
            }),
            new Paragraph({
              children: [
                new TextRun({ 
                  text: successChance ? (successChance.includes('%') ? successChance : `%${successChance}`) : "-", 
                  bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.DEADLINE_TEXT, font: FONT_FAMILY
                })
              ],
              alignment: AlignmentType.CENTER, spacing: { after: 120 }
            })
          ],
          shading: { fill: COLORS.DEADLINE_BG }, verticalAlign: "center",
          borders: { top: { style: "single", size: 8, color: COLORS.SIMILAR_HEADER } }
        })
      ]
    })
  );

  const comparisonTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: "single", size: 4, color: COLORS.SIMILAR_HEADER },
      bottom: { style: "single", size: 4, color: COLORS.SIMILAR_HEADER },
      left: { style: "single", size: 4, color: COLORS.SIMILAR_HEADER },
      right: { style: "single", size: 4, color: COLORS.SIMILAR_HEADER },
      insideHorizontal: { style: "single", size: 2, color: COLORS.BORDER_LIGHT },
      insideVertical: { style: "single", size: 2, color: COLORS.BORDER_LIGHT }
    },
    rows: tableRows
  });

  elements.push(comparisonTable);

  if (similarMark.note && String(similarMark.note).trim() !== "") {
    elements.push(new Paragraph({ text: "", spacing: { after: 150 } }));
    let logoBuffer = null;
    try { logoBuffer = await downloadImageAsBuffer('https://ip-manager-production-aab4b.web.app/evreka-logo.png'); } catch (e) { }

    const noteTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [
                ...(logoBuffer ? [ new Paragraph({ children: [ new ImageRun({ data: logoBuffer, transformation: { width: 100, height: 50 } }) ], alignment: AlignmentType.CENTER, spacing: { before: 100, after: 80 } }) ] : []),
                new Paragraph({ children: [ new TextRun({ text: "UZMAN DEĞERLENDİRMESİ", bold: true, size: GLOBAL_FONT_SIZE, color: COLORS.EXPERT_BORDER, font: FONT_FAMILY }) ], alignment: AlignmentType.CENTER, spacing: { before: logoBuffer ? 0 : 120, after: 120 } })
              ],
              shading: { fill: "FFFFFF" }, verticalAlign: "center",
              borders: { bottom: { style: "single", size: 4, color: COLORS.EXPERT_BORDER } }
            })
          ]
        }),
        new TableRow({
          children: [
            new TableCell({
              children: [
                new Paragraph({ children: [ new TextRun({ text: String(similarMark.note).trim(), size: GLOBAL_FONT_SIZE, color: COLORS.TEXT_DARK, font: FONT_FAMILY }) ], alignment: AlignmentType.LEFT, spacing: { before: 100, after: 100 } })
              ],
              shading: { fill: COLORS.EXPERT_BG }, margins: { left: 150, right: 150, top: 100, bottom: 100 }, verticalAlign: "center"
            })
          ]
        })
      ],
      borders: {
        top: { style: "single", size: 4, color: COLORS.EXPERT_BORDER },
        bottom: { style: "single", size: 4, color: COLORS.EXPERT_BORDER },
        left: { style: "single", size: 4, color: COLORS.EXPERT_BORDER },
        right: { style: "single", size: 4, color: COLORS.EXPERT_BORDER }
      }
    });
    elements.push(noteTable);
  }

  return elements;
}

// Yardımcı fonksiyon - Veri satırı oluşturma
function createInfoRow(label1, value1, label2, value2, isEven = false) {
  return new TableRow({
    height: { value: 600, rule: "atLeast" },
    children: [
      new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: label1 + " ",
                bold: true,
                size: 22,
                color: "2C3E50"
              }),
              new TextRun({
                text: value1,
                size: 22,
                color: "34495E"
              })
            ],
            spacing: { before: 150, after: 150 }
          })
        ],
        shading: { fill: bgColor },
        verticalAlign: "center",
        margins: {
          top: 150,
          bottom: 150,
          left: 200,
          right: 200
        },
        borders: {
          right: { style: "single", size: 2, color: "BDC3C7" }
        }
      }),
      new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: label2 + " ",
                bold: true,
                size: 22,
                color: "2C3E50"
              }),
              new TextRun({
                text: value2,
                size: 22,
                color: "34495E"
              })
            ],
            spacing: { before: 150, after: 150 }
          })
        ],
        shading: { fill: bgColor },
        verticalAlign: "center",
        margins: {
          top: 150,
          bottom: 150,
          left: 200,
          right: 200
        },
        borders: {
          left: { style: "single", size: 2, color: "BDC3C7" }
        }
      })
    ]
  });
}

// === YARDIMCI FONKSİYONLAR ===

function createInfoCell(label, value) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: label, bold: true }),
          new TextRun({ text: ` ${value}` })
        ]
      })
    ],
    width: { size: 50, type: WidthType.PERCENTAGE }
  });
}

function createSummaryHeaderCell(text) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: text,
            bold: true,
            color: "FFFFFF",
            size: 24
          })
        ],
        alignment: AlignmentType.CENTER
      })
    ],
    shading: { fill: "2E4BC7", type: "clear", color: "auto" }
  });
}

function createSummaryCell(text) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [new TextRun({ text: text, size: 22 })],
        alignment: AlignmentType.CENTER
      })
    ],
    shading: { fill: "F8F9FA", type: "clear", color: "auto" }
  });
}

function createDetailCell(label, value) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: label, bold: true, size: 22 }),
          new TextRun({ text: ` ${value}`, size: 22 })
        ]
      })
    ],
    width: { size: 50, type: WidthType.PERCENTAGE },
    shading: { fill: "F8F9FA", type: "clear", color: "auto" }
  });
}

function createTableHeaderCell(text) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: text,
            bold: true,
            color: "FFFFFF",
            size: 24
          })
        ],
        alignment: AlignmentType.CENTER
      })
    ],
    shading: { fill: "495057", type: "clear", color: "auto" }
  });
}

function createTableDataCell(text) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [new TextRun({ text: text || "-", size: 22 })]
      })
    ]
  });
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

// KULLANICI VE ADMIN YÖNETİMİ //

const strip = (s) => String(s ?? '').trim().replace(/^["'\s]+|["'\s]+$/g, '');

function canManageUsers(req) {
  console.log('🔍 Auth debug:', {
    hasAuth: !!req.auth,
    uid: req.auth?.uid,
    email: req.auth?.token?.email,
    role: req.auth?.token?.role,
    allClaims: req.auth?.token
  });
  
  if (!req.auth) return false;
  
  // Normal kontroller
  const claims = req.auth.token;
  const role = claims?.role;
  const email = claims?.email;
  const uid = req.auth.uid;
  
  // 1. Süper admin claim kontrolü
  if (role === 'superadmin') {
    console.log('✅ Access granted via superadmin role');
    return true;
  }
  
  // 2. Specific UID kontrolü (backup)
  if (uid === 'wH6MFM3jrYShxWDPkjr0Lbuj61F2') {
    console.log('✅ Access granted via specific UID');
    return true;
  }
  
  // 3. E-posta kontrolü (backup)
  if (email && email.includes('@evrekapatent.com')) {
    console.log('✅ Access granted via company email');
    return true;
  }
  
  console.log('❌ Access denied');
  return false;
}

// === Kullanıcı Oluştur/Güncelle (Auth + Firestore senkron) ===
export const adminUpsertUser = onCall({ region: "europe-west1" }, async (req) => {
  if (!canManageUsers(req)) {
    throw new HttpsError("permission-denied", "Yetkisiz istek.");
  }

  const uidInput      = strip(req.data?.uid);
  const emailInput    = strip(req.data?.email).toLowerCase();
  const newEmailInput = strip(req.data?.newEmail).toLowerCase();   // opsiyonel
  const displayName   = strip(req.data?.displayName);
  console.log('🔍 Backend received:', { 
    displayName, 
    emailInput,
    hasDisplayName: !!displayName 
});
  const role          = strip(req.data?.role || "user");
  const password      = String(req.data?.password || "");          // opsiyonel
  const disabledFlag  = req.data?.disabled;                         // opsiyonel (true/false)

  if (!uidInput && !emailInput) {
    throw new HttpsError("invalid-argument", "uid veya email zorunlu.");
  }
  if (!displayName) {
    throw new HttpsError("invalid-argument", "displayName zorunlu.");
  }

  // 1) Kullanıcıyı bul (uid veya email) — yoksa oluştur
  let userRecord;
  let existed = true;
  try {
    userRecord = uidInput
      ? await adminAuth.getUser(uidInput)
      : await adminAuth.getUserByEmail(emailInput);
  } catch (e) {
    if (e?.code === "auth/user-not-found") {
      existed = false;
    } else {
      throw new HttpsError("internal", `Kullanıcı sorgulanamadı: ${e?.message || e}`);
    }
  }

  if (!existed) {
    const createParams = { email: emailInput, displayName };
    if (password) createParams.password = password;
    userRecord = await adminAuth.createUser(createParams);
  }

  // 2) Güncelleme parametreleri
  const updateParams = {};
  if (displayName && displayName !== userRecord.displayName) updateParams.displayName = displayName;
  if (typeof disabledFlag === "boolean" && disabledFlag !== userRecord.disabled) updateParams.disabled = disabledFlag;
  if (password) updateParams.password = password;

  // E-posta değişikliği (çakışma kontrolü ile)
  const targetEmail = newEmailInput || emailInput || userRecord.email || "";
  if (targetEmail && targetEmail !== userRecord.email) {
    try {
      const other = await adminAuth.getUserByEmail(targetEmail);
      if (other.uid !== userRecord.uid) {
        throw new HttpsError("already-exists", "Bu e-posta başka bir kullanıcıda kayıtlı.");
      }
    } catch (e) {
      if (e?.code !== "auth/user-not-found") {
        throw new HttpsError("internal", `E-posta kontrolü başarısız: ${e?.message || e}`);
      }
      // user-not-found ise hedef e-posta kullanılabilir demektir
    }
    updateParams.email = targetEmail;
  }

  // 3) Auth güncelle
  if (Object.keys(updateParams).length) {
    userRecord = await adminAuth.updateUser(userRecord.uid, updateParams);
  }

  // 4) Custom claims (rol)
  if (role) {
    await adminAuth.setCustomUserClaims(userRecord.uid, { role });
  }

  // 5) Firestore profilini upsert et
  await adminDb.collection("users").doc(userRecord.uid).set(
    {
      email: userRecord.email,
      displayName: userRecord.displayName || displayName,
      role,
      disabled: !!userRecord.disabled,
      updatedAt: FieldValue.serverTimestamp(),
      ...(existed ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true }
  );

  return {
    uid: userRecord.uid,
    email: userRecord.email,
    existed,
    role,
    disabled: !!userRecord.disabled,
  };
});

export const onAuthUserCreate = auth.user().onCreate(async (user) => {
  // Email'den ad çıkar veya varsayılan kullan
  const displayName = user.displayName || 
                      user.email?.split('@')[0]?.replace(/[._-]/g, ' ') || 
                      'Yeni Kullanıcı';
  
  console.log(`🆔 Creating user profile: ${user.uid}, email: ${user.email}, displayName: "${displayName}"`);
  
  // 1. Firestore'a kaydet
  await adminDb.collection('users').doc(user.uid).set({
    email: user.email || '',
    displayName: displayName,
    role: 'belirsiz',
    disabled: !!user.disabled,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    _source: 'auth.user().onCreate'
  }, { merge: true });
  
  // 2. Custom claim olarak da "belirsiz" rolü ata
  await adminAuth.setCustomUserClaims(user.uid, { role: 'belirsiz' });
  
  console.log(`✅ User profile created successfully for ${user.uid} with role: belirsiz`);
});

export const onAuthUserDelete = auth.user().onDelete(async (user) => {
  await adminDb.collection('users').doc(user.uid).delete().catch(() => {});
});


export const adminDeleteUser = onCall({ region: "europe-west1" }, async (req) => {
  if (!canManageUsers(req)) {
    throw new HttpsError("permission-denied", "Yetkisiz istek.");
  }

  const uid = strip(req.data?.uid);
  if (!uid) throw new HttpsError("invalid-argument", "uid zorunlu.");

  const callerUid = req.auth?.uid;
  if (uid === callerUid) {
    throw new HttpsError("failed-precondition", "Kendi hesabınızı silemezsiniz.");
  }

  // 1) Auth'tan sil – hataları kontrollü map et
  try {
    await adminAuth.deleteUser(uid);
  } catch (e) {
    if (e?.code === "auth/user-not-found") {
      // Auth'ta yoksa bile Firestore'u temizleyip OK dönelim
      await adminDb.collection("users").doc(uid).delete().catch(() => {});
      return { ok: true, uid, note: "auth user not found; firestore cleaned" };
    }
    throw new HttpsError("internal", "Auth delete failed: " + (e?.message || e));
  }

  // 2) Firestore profilini sil (yoksa sorun değil)
  await adminDb.collection("users").doc(uid).delete().catch(() => {});

  // 3) (opsiyonel) Bu kullanıcıya atanmış işleri boşaltmak istiyorsan burada yap
  // const qs = await adminDb.collection('tasks').where('assignedTo_uid', '==', uid).get();
  // const w = db.bulkWriter();
  // qs.forEach(d => w.update(d.ref, { assignedTo_uid: null, assignedTo_email: null }));
  // await w.close();

  return { ok: true, uid };
});

// ====== IMPORTS ======
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

// Ensure admin is initialized once
if (!getApps().length) {
  initializeApp();
}

// Basit bellek içi cache ve cookie jar (aynı instance yaşadığı sürece geçerli)
const __tpCache   = global.__tpCache   || (global.__tpCache   = new Map());
const __cookieJar = global.__cookieJar || (global.__cookieJar = new Map());

// Küçük yardımcılar
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const loadCookiesFor = (key) => __cookieJar.get(key) || [];
const saveCookiesFor = (key, cookies) => __cookieJar.set(key, cookies);

// ====== Data URL parse helper ======
function parseDataUrl(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) throw new Error('Geçersiz data URL');
  const contentType = m[1];
  const base64 = m[2];
  const buffer = Buffer.from(base64, 'base64');
  const ext = contentType.split('/')[1].replace('jpeg', 'jpg');
  return { contentType, buffer, ext };
}

// ====== Görseli Storage'a yazan yardımcı ======
async function persistImageToStorage(src, applicationNumber) {
  try {
    const bucket = getStorage().bucket();
    const safeAppNo = String(applicationNumber || 'unknown').replace(/[^\w-]/g, '_');
    let buffer, contentType, ext;

    if (String(src).startsWith('data:')) {
      const parsed = parseDataUrl(src);
      buffer = parsed.buffer;
      contentType = parsed.contentType;
      ext = parsed.ext;
    } else {
      // HTTP(S) kaynağını indir
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`Resim indirilemedi: ${resp.status}`);
      const arrayBuf = await resp.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
      contentType = resp.headers.get('content-type') || 'image/jpeg';
      ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    }

    const filePath = `trademarks/${safeAppNo}/logo.${ext}`;
    const file = bucket.file(filePath);
    const token = uuidv4();
    await file.save(buffer, {
      contentType,
      resumable: false,
      metadata: {
        cacheControl: "public,max-age=31536000",
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    const downloadURL =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filePath)}?alt=media&token=${token}`;

    return {
      imagePath: filePath,
      imageSignedUrl: downloadURL,   // geriye dönük uyumluluk
      publicImageUrl: downloadURL,   // ✅ gerçekten çalışan URL
    };

  } catch (e) {
    logger.warn('Görsel Storage’a kaydedilemedi, data URL döndürülecek.', { message: e?.message });
    return { imagePath: '', imageSignedUrl: '', publicImageUrl: '' };
  }
}

// ====== reCAPTCHA tespiti (bypass YOK) ======
async function detectCaptcha(page) {
  const text = (await page.evaluate(() => document.body.innerText || '')).toLowerCase();
  return /recaptcha|ben robot değilim|i'm not a robot|lütfen doğrulayın/.test(text);
}

// ====== MUI tablolarını DOM'dan parse eden fonksiyon ======
function domParseFn() {
  const out = {
    applicationNumber:null, applicationDate:null, registrationNumber:null, registrationDate:null,
    intlRegistrationNumber:null, documentNumber:null, bulletinDate:null, bulletinNo:null,
    regBulletinDate:null, regBulletinNo:null, protectionDate:null, status:null, priorityInfo:null,
    niceClasses:[], type:null, trademarkName:null, agentInfo:null, ownerId:null, owner:null, ownerAddress:null,
    decision:null, decisionReason:null, goods:[], imageUrl:null, found:false
  };

  const normDate = (s) => {
    const m = (s||'').match(/\b(\d{2})[./](\d{2})[./](\d{4})\b/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || null);
  };
  const txt = (n) => (n && (n.textContent || '')).trim();
  const dashToEmpty = (v) => (v === '-' ? '' : v);

  const tables = Array.from(document.querySelectorAll('table.MuiTable-root'));
  if (!tables.length) return out;

  // 1) Özet tablo (label/value)
  const t0 = tables[0];
  const rows0 = t0.querySelectorAll('tbody tr');

  rows0.forEach(tr => {
    const tds = Array.from(tr.querySelectorAll('td'));
    if (tds.length === 2) {
      const label = txt(tds[0]).toLowerCase();
      const cell  = tds[1];
      const raw   = txt(cell);
      const val   = dashToEmpty(raw);

      if (label.includes('marka adı')) out.trademarkName = val;
      else if (label.includes('sahip bilgileri')) {
        const ps = Array.from(cell.querySelectorAll('p')).map(txt).filter(Boolean);
        out.ownerId = ps[0] || null;
        out.owner = ps[1] || null;
        out.ownerAddress = ps.slice(2).join(' ') || null;
      }
      else if (label.includes('rüçhan bilgileri')) out.priorityInfo = val;
      else if (label.includes('vekil bilgileri')) {
        const ps = Array.from(cell.querySelectorAll('p')).map(txt).filter(Boolean);
        out.agentInfo = ps.join(' - '); // İsim ve Firma bilgisini birleştirir
      }
    } else if (tds.length === 4) {
      const label1 = txt(tds[0]).toLowerCase(), value1 = dashToEmpty(txt(tds[1]));
      const label2 = txt(tds[2]).toLowerCase(), value2 = dashToEmpty(txt(tds[3]));

      // --- ÖNCE daha spesifik olanları kontrol et ---
      if (label1.includes('uluslararası tescil numarası')) out.intlRegistrationNumber = value1;
      else if (label1.includes('tescil numarası')) out.registrationNumber = value1;
      else if (label1.includes('başvuru numarası')) out.applicationNumber = value1;
      else if (label1.includes('marka ilan bülten tarihi')) out.bulletinDate = normDate(value1);
      else if (label1.includes('marka ilan bülten no')) out.bulletinNo = value1;
      else if (label1.includes('tescil yayın bülten tarihi')) out.regBulletinDate = normDate(value1);
      else if (label1.includes('tescil yayın bülten no')) out.regBulletinNo = value1;
      else if (label1.includes('koruma tarihi')) out.protectionDate = normDate(value1);
      else if (label1.includes('nice sınıfları')) {
        out.niceClasses = (value1 || '')
          .split(/[^\d]+/)
          .map(s => s.trim())
          .filter(Boolean);
      } else if (label1.includes('karar')) out.decision = value1;

      if (label2.includes('uluslararası tescil numarası')) out.intlRegistrationNumber = value2;
      else if (label2.includes('tescil numarası')) out.registrationNumber = value2;
      else if (label2.includes('başvuru tarihi')) out.applicationDate = normDate(value2);
      else if (label2.includes('tescil tarihi')) out.registrationDate = normDate(value2);
      else if (label2.includes('evrak numarası')) out.documentNumber = value2;
      else if (label2.includes('tescil yayın bülten tarihi')) out.regBulletinDate = normDate(value2);
      else if (label2.includes('tescil yayın bülten no')) out.regBulletinNo = value2;
      else if (label2.includes('marka ilan bülten tarihi')) out.bulletinDate = normDate(value2);
      else if (label2.includes('marka ilan bülten no')) out.bulletinNo = value2;
      else if (label2.includes('durumu')) out.status = value2;
      else if (label2 === 'türü') out.type = value2;
      else if (label2.includes('karar gerekçesi')) out.decisionReason = value2;
    }
  });

  // 2) GOODS tablosunu THEAD başlığıyla tespit et
  const goodsTable = tables.find(t => {
    const ths = Array.from(t.querySelectorAll('thead th'));
    return ths.length >= 2 &&
           /sınıf/i.test(txt(ths[0])) &&
           /mal ve hizmetler/i.test(txt(ths[1]));
  });

  if (goodsTable) {
    const rows1 = goodsTable.querySelectorAll('tbody tr');
    rows1.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      const cls = txt(tds[0]);
      const desc = txt(tds[1]);
      if (cls) out.goods.push({ class: cls, description: desc });
    });
  }

  // 3) Görsel (data URL veya URL)
  const scope = t0.closest('section,div,main') || document;
  const img = scope.querySelector('img[alt*="Marka"], img[src^="data:image"], img[src*="resim"], img[src*="marka"], .trademark-image img');
  if (img && img.src && !/icon|logo|button|avatar/i.test(img.src)) {
    try { out.imageUrl = new URL(img.src, location.href).href; }
    catch { out.imageUrl = img.src; }
  }

  out.found = !!(out.trademarkName || out.applicationNumber || out.registrationNumber);
  return out;
}

// ====== COMMON HANDLER ======
async function handleScrapeTrademark(basvuruNo) {
  if (!basvuruNo) {
    throw new HttpsError('invalid-argument', 'Başvuru numarası (basvuruNo) zorunludur.');
  }

  logger.info('[scrapeTrademarkPuppeteer] Başlıyor', { basvuruNo });

  // ---- 0) 5 dk Cache ----
  const cached = __tpCache.get(basvuruNo);
  if (cached && (Date.now() - cached.ts) < 5 * 60 * 1000) {
    logger.info('Cache hit, 5 dk içindeki sonucu döndürüyorum.');
    return cached.data;
  }

  // ---- 1) Global oran sınırlama (45–60 sn jitter) ----
  const lastRequestKey = 'turkpatent_last_request';
  const minDelay = 45000 + Math.floor(Math.random() * 15000);
  const lastRequest = global[lastRequestKey] || 0;
  const elapsed = Date.now() - lastRequest;
  if (elapsed < minDelay) {
    const waitTime = minDelay - elapsed;
    logger.info(`Rate limiting: ${waitTime}ms bekleyecek`);
    await sleep(waitTime);
  }
  global[lastRequestKey] = Date.now();

  // ---- 2) Global BACKOFF ----
  const tpBackoffKey = 'turkpatent_backoff_until';
  const backoffRemaining = Math.max(0, (global[tpBackoffKey] || 0) - Date.now());
  if (backoffRemaining > 0) {
    const retryAfterSec = Math.ceil(backoffRemaining / 1000);
    logger.info(`Backoff aktif, ${retryAfterSec}s sonra tekrar deneyin.`);
    return {
      status: 'Backoff',
      found: false,
      applicationNumber: basvuruNo,
      retryAfterSec,
      message: 'TürkPatent geçici limitten dolayı bekleme süresi aktif.'
    };
  }

  let browser;
  let page;

  try {
const isLocal = process.env.FUNCTIONS_EMULATOR === 'true';

const launchOptions = isLocal ? {
  headless: true,
  executablePath: process.env.CHROME_PATH || await chromium.executablePath(),
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  defaultViewport: { width: 1920, height: 1080 }
} : {
  headless: chromium.headless,
  executablePath: await chromium.executablePath(),
  args: [
    ...chromium.args,
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-features=VizDisplayCompositor',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security'
  ],
  defaultViewport: { width: 1920, height: 1080 }
};


    const browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),  // 🔴 kritik satır
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      protocolTimeout: 180000
    });

    page = await browser.newPage();

    // --- Stealth / Kimlik ayarları ---
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7' });
    try { await page.emulateTimezone('Europe/Istanbul'); } catch {}
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // --- Cookie reuse ---
    const savedCookies = loadCookiesFor('turkpatent');
    if (savedCookies.length) {
      try { await page.setCookie(...savedCookies); } catch {}
    }

    // Network monitoring ve request interceptor
      await page.setRequestInterception(true);
      
      page.on('request', (request) => {
        logger.info('Request:', request.url(), request.method());
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      page.on('response', (response) => {
        if (response.url().includes('turkpatent') || response.url().includes('api') || response.url().includes('search')) {
          logger.info('Response:', response.url(), response.status());
        }
      });

    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    logger.info('[scrapeTrademarkPuppeteer] Sayfaya gidiliyor...');
    await page.goto('https://www.turkpatent.gov.tr/arastirma-yap?form=trademark', { waitUntil: 'domcontentloaded' });

    // --- Popup/Modal kapat ---
    try {
      try { await page.waitForSelector('.jss84 .jss92', { timeout: 2000 }); await page.click('.jss84 .jss92'); } catch {}
      try {
        await page.waitForSelector('[role="dialog"], .MuiDialog-root, .MuiModal-root', { timeout: 2000 });
        const closeBtn = await page.$('button[aria-label="Close"], button[aria-label="Kapat"], .close');
        if (closeBtn) { await closeBtn.click(); }
      } catch {}
    } catch (modalError) {
      logger.info('Modal kapatma hatası (normal):', { message: modalError?.message });
    }

    // --- "Dosya Takibi" sekmesi ---
    try {
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button[role="tab"]');
        for (const btn of buttons) {
          if (btn.textContent && btn.textContent.includes('Dosya Takibi')) {
            if (btn.getAttribute('aria-selected') !== 'true') btn.click();
            return;
          }
        }
      });
      await page.waitForSelector('input[placeholder="Başvuru Numarası"]', { timeout: 5000 });
      logger.info('Dosya Takibi sekmesine geçiş başarılı.');
    } catch (tabError) {
      logger.error('Dosya Takibi sekmesine geçiş hatası:', { message: tabError?.message });
      throw new HttpsError('internal', `Tab geçişi başarısız: ${tabError.message}`);
    }

    // --- Form doldur ---
    logger.info('[scrapeTrademarkPuppeteer] Form doldurma işlemi...');
    try {
      await page.waitForSelector('input[placeholder="Başvuru Numarası"]', { timeout: 5000 });
      const input = await page.$('input[placeholder="Başvuru Numarası"]');
      if (!input) throw new Error('Başvuru numarası input alanı bulunamadı');

      await input.click({ clickCount: 3 });
      await input.type(basvuruNo);
      await page.evaluate((inputEl, value) => {
        inputEl.value = value;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }, input, basvuruNo);

      logger.info(`Başvuru numarası yazıldı: ${basvuruNo}`);
    } catch (inputError) {
      logger.error('Form doldurma hatası:', { message: inputError?.message });
      throw new HttpsError('internal', `Form doldurma başarısız: ${inputError.message}`);
    }

    // --- TEK TIK + DOM BEKLEME (JSON YOK) ---
    logger.info('[scrapeTrademarkPuppeteer] Sorgula butonu tıklanıyor ve DOM bekleniyor...');
    await sleep(400 + Math.floor(Math.random() * 600)); // küçük jitter

    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /sorgula/i.test((b.textContent || '')) && !b.disabled && !b.getAttribute('aria-disabled'));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new HttpsError('internal', 'Sorgula butonu bulunamadı');

    // Captcha kontrolü (bypass yok; anlamlı dönüş)
    if (await detectCaptcha(page)) {
      const retryAfterSec = 120 + Math.floor(Math.random()*60);
      global['turkpatent_backoff_until'] = Date.now() + retryAfterSec * 1000;
      return {
        status: 'CaptchaRequired',
        found: false,
        applicationNumber: basvuruNo,
        retryAfterSec,
        message: 'reCAPTCHA doğrulaması gerekiyor. Lütfen doğrulayıp tekrar deneyin.'
      };
    }

    // DOM yüklenmesini bekle
    await page.waitForSelector('table#results tbody tr', { timeout: 60000 });

    // DOM'dan veriyi çek
    const tdata = await page.evaluate(domParseFn);

    // Basit hata metni taraması
    const hasError = await page.evaluate(() => {
      const els = document.querySelectorAll('.error, .alert-danger, .MuiAlert-message, p, div, span, h1, h2, h3');
      const keys = ['bulunamadı','sonuç yok','hata','geçersiz','çok fazla deneme','too many attempts','rate limit','sistem meşgul','geçici olarak hizmet dışı'];
      for (const el of Array.from(els)) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (keys.some(k => t.includes(k))) return (el.textContent || '').trim();
      }
      return null;
    });

    if (hasError) {
      return { applicationNumber: basvuruNo, found: false, status: 'NotFound', message: hasError, error: hasError };
    }

    if (!tdata?.found) {
      const pageTitle = await page.title();
      return { applicationNumber: basvuruNo, found: false, status: 'DataExtractionError', message: 'Sayfa yüklendi ancak veri çıkarılamadı', pageTitle };
    }

    // Normalizasyon
    const normalized = {
      applicationNumber: tdata.applicationNumber || basvuruNo,
      applicationDate:  tdata.applicationDate || '',
      trademarkName:    tdata.trademarkName || '',
      imageUrl:         tdata.imageUrl || '',
      owner:            tdata.owner || '',
      status:           tdata.status || '',
      niceClasses:      Array.isArray(tdata.niceClasses) ? tdata.niceClasses : [],

      // ek alanlar
      registrationNumber:        tdata.registrationNumber || '',
      registrationDate:          tdata.registrationDate || '',
      intlRegistrationNumber:    tdata.intlRegistrationNumber || '',
      documentNumber:            tdata.documentNumber || '',
      bulletinDate:              tdata.bulletinDate || '',
      bulletinNo:                tdata.bulletinNo || '',
      regBulletinDate:           tdata.regBulletinDate || '',
      regBulletinNo:             tdata.regBulletinNo || '',
      protectionDate:            tdata.protectionDate || '',
      type:                      tdata.type || '',
      ownerId:                   tdata.ownerId || '',
      ownerAddress:              tdata.ownerAddress || '',
      agentInfo:                 tdata.agentInfo || '',
      decision:                  tdata.decision || '',
      decisionReason:            tdata.decisionReason || '',
      goods:                     Array.isArray(tdata.goods) ? tdata.goods : []
    };

    logger.info('Marka verisi DOM’dan çıkarıldı', {
      applicationNumber: normalized.applicationNumber,
      applicationDate: normalized.applicationDate,
      trademarkName: normalized.trademarkName,
      hasImage: !!normalized.imageUrl,
      goodsCount: normalized.goods.length
    });

    // --- Görsel varsa Storage'a yaz ve linkleri ekle ---
    if (normalized.imageUrl) {
      const { imagePath, imageSignedUrl, publicImageUrl } = await persistImageToStorage(normalized.imageUrl, normalized.applicationNumber);
      if (imagePath) {
        normalized.imagePath = imagePath;
        normalized.imageSignedUrl = imageSignedUrl;
        normalized.publicImageUrl = publicImageUrl;
        // UI kolaylığı için imageUrl'ü imzalı URL ile değiştir
        normalized.imageUrl = imageSignedUrl || publicImageUrl || normalized.imageUrl;
      }
    }

    const result = { status: 'Success', found: true, data: normalized, ...normalized };
    __tpCache.set(basvuruNo, { ts: Date.now(), data: result });
    return result;

  } catch (err) {
    logger.error('[scrapeTrademarkPuppeteer] Genel hata', { message: err?.message, stack: err?.stack, basvuruNo });
    throw new HttpsError('internal', `Puppeteer hatası: ${err?.message || String(err)}`);
  } finally {
    // Cookie’leri sakla (başarılı/başarısız fark etmez)
    try {
      // eslint-disable-next-line no-undef
      if (typeof page !== 'undefined' && page) {
        const freshCookies = await page.cookies();
        if (freshCookies?.length) saveCookiesFor('turkpatent', freshCookies);
      }
    } catch {}

    if (typeof browser !== 'undefined' && browser) {
      try { await browser.close(); logger.info('Browser kapatıldı'); }
      catch (closeError) { logger.error('Browser kapatma hatası:', { message: closeError?.message }); }
    }
  }
}

// ====== CALLABLE (onCall) VERSİYONU ======
export const scrapeTrademark = onCall(
  { region: 'europe-west1', memory: '2GiB', timeoutSeconds: 180 },
  async (request) => {
    const basvuruNo = request.data?.basvuruNo;
    return await handleScrapeTrademark(basvuruNo);
  }
);
// ====== YENİLENMİŞ SAHİP NUMARASI İLE TOPLU MARKA ARAMA (FOUND YALNIZCA SATIR VARSA) ======
// ====== YENİLENMİŞ SAHİP NUMARASI İLE TOPLU MARKA ARAMA (iframe + role="number" + role-öncelikli parse) ======
export const scrapeOwnerTrademarks = onCall(
  { region: 'europe-west1', memory: '2GiB', timeoutSeconds: 300 },
  async (request) => {
    const { ownerId, maxRetries = 2 } = request.data || {};
    if (!ownerId) {
      throw new HttpsError('invalid-argument', 'Sahip numarası (ownerId) zorunludur.');
    }

    logger.info('[scrapeOwnerTrademarks] Başlıyor', { ownerId, maxRetries });

    const isLocal = !!process.env.FUNCTIONS_EMULATOR || (!process.env.K_SERVICE && process.env.NODE_ENV !== 'production');
    let browser;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        logger.info(`Deneme ${retryCount + 1}/${maxRetries} başlıyor...`);

        // === Browser Başlatma ===
        if (isLocal) {
          const puppeteerLocal = await import('puppeteer');
          browser = await puppeteerLocal.default.launch({
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: { width: 1366, height: 900 },
          });
        } else {
          const execPath = await chromium.executablePath();
          browser = await puppeteer.launch({
            args: [
              ...chromium.args,
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: chromium.defaultViewport || { width: 1366, height: 900 },
            executablePath: execPath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
          });
        }

        const page = await browser.newPage();
        await page.setJavaScriptEnabled(true);
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Basit bot-detection bypass
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
          window.chrome = {
            runtime: {},
            loadTimes: function () { return { requestTime: Date.now() / 1000 }; },
            csi: function () { return { startE: Date.now(), onloadT: Date.now() }; },
          };
        });

        // Request interception - reCAPTCHA isteklerini engelle + hafif içerik diyeti
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const url = req.url();
          const resourceType = req.resourceType();

          if (
            url.includes('recaptcha') ||
            url.includes('gstatic.com/recaptcha') ||
            url.includes('google.com/recaptcha')
          ) {
            logger.info('reCAPTCHA isteği engellendi');
            req.abort();
            return;
          }

          if (['image', 'stylesheet', 'font', 'media', 'manifest'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });

        // Sayfayı yükle
        await page.goto('https://www.turkpatent.gov.tr/arastirma-yap', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        logger.info('Sayfa başarıyla yüklendi.');

        // İnsan benzeri küçük davranış
        await page.mouse.move(200, 200);
        await page.mouse.click(200, 200);
        await page.keyboard.type('test');
        await sleep(700);

        // === Form Doldurma ===
        await page.waitForSelector('input', { timeout: 10000 });

        const inputResult = await page.evaluate((val) => {
          const input =
            document.querySelector('input[placeholder*="Kişi Numarası" i]') ||
            document.querySelector('input[placeholder*="kişi" i]') ||
            Array.from(document.querySelectorAll('input')).find(
              (i) =>
                (i.placeholder || '').toLowerCase().includes('kişi') ||
                (i.placeholder || '').toLowerCase().includes('numara')
            );
          if (!input) return { success: false, error: 'Kişi Numarası inputu bulunamadı' };

          input.focus();
          input.value = '';
          input.value = String(val);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }, String(ownerId));

        if (!inputResult.success) {
          throw new Error(inputResult.error);
        }

        await sleep(600);

        // === Sorgula Butonuna Tıklama ===
        const clickResult = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(
            (b) => /sorgula/i.test((b.textContent || b.value || '').trim()) && !b.disabled
          );
          if (!btn) return { success: false, error: 'SORGULA butonu bulunamadı' };
          btn.click();
          return { success: true };
        });

        if (!clickResult.success) {
          throw new Error(clickResult.error);
        }

        logger.info('Sorgula butonuna tıklandı, sonuçlar bekleniyor...');

        // === Selector listeleri (satır tespiti için) ===
        const rowSelectorList = [
          'table tbody tr[role="number"]',
          'table tbody tr',
          '.MuiTable-root tbody tr[role="number"]',
          '.MuiTable-root tbody tr',
          '[role="table"] tbody tr',
          // MUI DataGrid / virtualized:
          '[role="grid"] [role="row"]',
          '[role="rowgroup"] [role="row"]',
          'tbody tr[role="number"]',
          'tbody tr'
        ];

        // === Her frame’de satır var mı kontrolü (iframe-aware probe) ===
        async function probeAnyFrame(page) {
          const frames = [page.mainFrame(), ...page.frames()];
          for (const f of frames) {
            try {
              const res = await f.evaluate((selectors) => {
                const bodyText = (document.body.innerText || '').toLowerCase();

                const loadingKw = ['yükleniyor', 'loading', 'bekleyin', 'aranıyor'];
                const notFoundKw = ['0 kayıt bulundu', 'kayıt bulunamadı', 'sonuç bulunamadı', 'hiç kayıt', 'sonuç yok'];
                const errKw = ['hata oluştu', 'sistem hatası', 'geçici hata'];

                const isLoading   = loadingKw.some(k => bodyText.includes(k));
                const hasNotFound = notFoundKw.some(k => bodyText.includes(k));
                const hasError    = errKw.some(k => bodyText.includes(k));

                let rowCount = 0, usedSelector = '';
                for (const sel of selectors) {
                  const n = document.querySelectorAll(sel).length;
                  if (n > 0) { rowCount = n; usedSelector = sel; break; }
                }

                // İlk 2 satır ön izlemesi
                const firstRowsPreview = [];
                if (rowCount > 0) {
                  const trs = document.querySelectorAll(usedSelector);
                  const lim = Math.min(2, trs.length);
                  for (let i = 0; i < lim; i++) {
                    firstRowsPreview.push((trs[i].innerText || '').replace(/\s+/g, ' ').trim());
                  }
                }

                return { isLoading, hasNotFound, hasError, rowCount, usedSelector, firstRowsPreview };
              }, rowSelectorList);

              if (res?.rowCount > 0 || res?.hasNotFound || res?.hasError) {
                return { frame: f, ...res };
              }
            } catch {}
          }
          return null;
        }

        // === GELİŞTİRİLMİŞ SONUÇ BEKLEME: "found" sadece gerçek satır varsa ===
        let status = null;
        let foundFrame = null;
        const maxWaitTime = 120000; // 2 dk
        const pollEvery = 1500;
        const t0 = Date.now();

        while (Date.now() - t0 < maxWaitTime) {
          const p = await probeAnyFrame(page);
          if (p) {
            logger.info('[probe]', {
              rowCount: p.rowCount,
              usedSelector: p.usedSelector,
              isLoading: p.isLoading,
              hasNotFound: p.hasNotFound,
              hasError: p.hasError
            });

            if (p.rowCount > 0 && !p.isLoading) {
              status = 'found';
              foundFrame = p.frame;  // satırlar hangi frame’deyse onu kullan
              logger.info('Sonuç durumu belirlendi: found (satır sayısı: ' + p.rowCount + ')');
              if (p.firstRowsPreview?.length) logger.info('[rows-preview]', { rows: p.firstRowsPreview });
              break;
            }
            if (p.hasNotFound && !p.isLoading) { status = 'not_found'; break; }
            if (p.hasError) { status = 'error'; break; }
          }
          await sleep(pollEvery);
        }

        if (!status) {
          logger.warn('Timeout: Sonuç durumu belirlenemedi');
          status = 'timeout';
        }

        // Found ise en az bir satır görünene kadar garanti bekleyelim
        if (status === 'found') {
          try {
            await (foundFrame || page).waitForSelector(
              'table tbody tr, .MuiTable-root tbody tr, [role="grid"] [role="row"]',
              { visible: true, timeout: 30000 }
            );
          } catch {}
        }

        // === SONUÇ İŞLEME / PARSE (role-öncelikli + iframe-aware + DEBUG) ===
        if (status === 'found') {
          logger.info('Veri çekiliyor...');
          await sleep(800);

          const frameForParse = foundFrame || page.mainFrame();

          const { rows, rowCount, usedSelector } = await frameForParse.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

            const selectors = [
              'table tbody tr[role="number"]',
              '.MuiTable-root tbody tr[role="number"]',
              '[role="table"] tbody tr[role="number"]',
              'table tbody tr',
              '.MuiTable-root tbody tr',
              '[role="table"] tbody tr',
              // fallback’lar:
              '[role="grid"] [role="row"]',
              '[role="rowgroup"] [role="row"]',
              'tbody tr[role="number"]',
              'tbody tr'
            ];

            let trs = [];
            let usedSelector = '';
            for (const sel of selectors) {
              const list = document.querySelectorAll(sel);
              if (list.length > 0) { trs = Array.from(list); usedSelector = sel; break; }
            }

            const rows = trs.map((tr, index) => { // <-- Index eklendi
              
              // [DEBUG LOGLAMA] 1. Satırın ham metnini al
              let debugRaw = null;
              if (index === 0) {
                  // Satırdaki tüm metni '|' ile birleştirir (Kolon ayrımı için ipucu)
                  debugRaw = (tr.innerText || '').replace(/[\n\r]+/g, ' | '); 
              }

              // Önce role’lü hücre
              const byRole = (role) => {
                const el =
                  tr.querySelector(`td[role="${role}"]`) ||
                  tr.querySelector(`[role="cell"][data-field="${role}"]`);
                return el ? norm(el.innerText) : '';
              };

              // Sonra index fallback (ilk kolon numara/checkbox olabilir)
              let cells = Array.from(tr.querySelectorAll('td'));
              if (cells.length === 0) cells = Array.from(tr.querySelectorAll('[role="cell"]'));
              const get = (i) => (cells[i] ? norm(cells[i].innerText) : '');

              const applicationNumber = byRole('applicationNo')   || get(1) || get(0);
              const brandName        = byRole('markName')        || get(2) || get(1);
              const ownerName        = byRole('holdName')        || get(3) || get(2);
              const applicationDate  = byRole('applicationDate') || get(4) || get(3);
              const registrationNo   = byRole('registrationNo')  || get(5) || get(4);
              const state            = byRole('state')           || get(6) || get(5);
              const niceText         = byRole('niceClasses')     || get(7) || get(6);
              
              // [VEKİL BİLGİSİ] 
              // Nice sınıfları genellikle 7. veya 6. indekste olur. Vekil muhtemelen 8'dedir.
              const attorneyName     = byRole('agentName') || byRole('attorneyName') || get(8) || '';

              const niceList = (niceText || '')
                .split(/[^\d]+/)
                .map(x => x.trim())
                .filter(Boolean);

              const img = tr.querySelector('img') || tr.querySelector('picture img') || tr.querySelector('[role="cell"] img');
              const a   = tr.querySelector('a[href]');

              return {
                applicationNumber,
                brandName,
                ownerName,
                applicationDate,
                registrationNumber: registrationNo,
                status: state,
                niceClasses: niceText,
                niceList,
                attorneyName, // <-- Vekil verisi eklendi
                _debugRaw: debugRaw, // <-- Debug verisi eklendi
                imageUrl: img ? img.getAttribute('src') : '',
                detailUrl: a ? a.getAttribute('href') : ''
              };
            }).filter(r => r && (r.applicationNumber || r.brandName));

            return { rows, rowCount: trs.length, usedSelector };
          });

          logger.info(`[owner-scrape] Satır sayısı (ham): ${rowCount} | Kullanılan selector: ${usedSelector}`);
          logger.info(`[owner-scrape] Parse sonrası kayıt: ${rows.length}`);

          if (rows.length === 0) {
            // Teşhis için ilk satırdan kısa HTML kesiti
            try {
              const snippet = await (foundFrame || page).evaluate((sel) => {
                const tr = document.querySelector(sel);
                if (!tr) return '';
                const html = tr.outerHTML || '';
                return html.slice(0, 600);
              }, usedSelector);
              if (snippet) logger.info('[first-tr-html-snippet]', { snippet });
            } catch {}

            return {
              status: 'NotFound',
              found: false,
              ownerId,
              count: 0,
              message: 'Tablo bulundu ancak veri yok'
            };
          }

          return {
            status: 'Success',
            found: true,
            count: rows.length,
            ownerId,
            items: rows
          };

        } else if (status === 'not_found') {
          logger.info('Kayıt bulunamadı.');
          return {
            status: 'NotFound',
            found: false,
            ownerId,
            count: 0,
            message: 'Belirtilen sahip numarası için kayıt bulunamadı.'
          };

        } else {
          throw new Error(`Beklenmeyen durum: ${status}`);
        }

      } catch (err) {
        logger.error(`[scrapeOwnerTrademarks] Deneme ${retryCount + 1} hatası:`, { message: err?.message });

        // Screenshot al (debug)
        if (browser) {
          try {
            const pages = await browser.pages();
            if (pages.length > 0) {
              const screenshot = await pages[0].screenshot({ encoding: 'base64', quality: 30 });
              if (screenshot) logger.info('Hata screenshot alındı');
            }
          } catch (e) {
            logger.warn('Screenshot alınamadı:', e.message);
          }
        }

        if (retryCount >= maxRetries - 1) {
          throw new HttpsError('internal', `Owner arama hatası (${maxRetries} deneme): ${err?.message || String(err)}`);
        }

        retryCount++;
        logger.info(`${retryCount + 1}. deneme için bekleniyor...`);
        await sleep(5000 * retryCount);

      } finally {
        if (browser) {
          try {
            await browser.close();
            browser = null;
            logger.info('Browser kapatıldı');
          } catch (e) {
            logger.warn('Browser kapatma hatası:', e.message);
          }
        }
      }
    }

    throw new HttpsError('internal', 'Tüm denemeler başarısız oldu');
  }
);

// =========================================================
//              YENİ: YENİLEME OTOMASYON FONKSİYONU
// =========================================================

/**
 * Portföy kayıtlarındaki yenileme tarihlerini kontrol ederek
 * yeni yenileme görevleri oluşturan callable fonksiyon.
 * Kurallar:
 * - taskType: '22'
 * - ipRecords status "geçersiz" veya "rejected" olmamalı
 * - Yenileme tarihi bugünden 6 ay önce veya sonraki aralığa girmeli
 * - WIPO/ARIPO kayıtları için sadece 'parent' hiyerarşisindekiler işleme alınır.
 * - Atama, taskAssignments koleksiyonundaki kurala göre yapılır.
 */
async function resolveApprovalAssignee(adminDb, taskTypeId = "22") {
  const out = { uid: null, email: null, reason: "unknown" };

  const snap = await adminDb.collection("taskAssignments").doc(String(taskTypeId)).get();
  if (!snap.exists) { out.reason = "rule-missing"; return out; }

  const rule = snap.data() || {};
  const list = Array.isArray(rule.approvalStateAssigneeIds) ? rule.approvalStateAssigneeIds : [];
  if (!list.length) { out.reason = "approvalStateAssigneeIds-empty"; return out; }

  const uid = String(list[0]);
  const userSnap = await adminDb.collection("users").doc(uid).get();
  if (!userSnap.exists) { out.reason = "user-missing"; return out; }

  const email = userSnap.data()?.email || null;
  if (!email) { out.reason = "email-missing"; return out; }

  return { uid, email, reason: "ok" };
}

// Türkçe tarih formatını (GG.AA.YYYY veya GG/AA/YYYY) parse eden yardımcı fonksiyon
function parseTurkishDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  
  // GG.AA.YYYY veya GG/AA/YYYY formatını kontrol et
  const match = dateStr.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // JavaScript ayları 0-indexed
    const year = parseInt(match[3], 10);
    const d = new Date(year, month, day);
    // Geçerli tarih kontrolü
    if (!isNaN(d.getTime()) && d.getDate() === day && d.getMonth() === month && d.getFullYear() === year) {
      return d;
    }
  }
  
  // ISO formatı veya diğer formatları dene
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

export const checkAndCreateRenewalTasks = onCall({ region: "europe-west1" }, async (request) => {
  logger.log('🔄 Renewal task check started manually with updated transaction logic');

  const taskTypeId = "22";
  const TODAY = new Date();
  const sixMonthsAgo = new Date();  sixMonthsAgo.setMonth(TODAY.getMonth() - 6);
  const sixMonthsLater = new Date(); sixMonthsLater.setMonth(TODAY.getMonth() + 6);

  // 1) Atama: taskAssignments/22 kuralından kullanıcıyı bul
  let assignedTo_uid = null;
  let assignedTo_email = null;
  let assignedTo_name = "Sistem Otomasyonu"; // Varsayılan isim

  try {
    const ruleSnap = await adminDb.collection("taskAssignments").doc(taskTypeId).get();
    if (!ruleSnap.exists) throw new HttpsError("failed-precondition", "taskAssignments/22 bulunamadı");

    const rule = ruleSnap.data() || {};
    const approvalIds = Array.isArray(rule.approvalStateAssigneeIds) ? rule.approvalStateAssigneeIds : [];
    if (!approvalIds.length) throw new HttpsError("failed-precondition", "approvalStateAssigneeIds boş");

    const uid = String(approvalIds[0]);
    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) throw new HttpsError("failed-precondition", `users/${uid} bulunamadı`);
    
    const userData = userSnap.data();
    const email = userData?.email || null;
    if (!email) throw new HttpsError("failed-precondition", `users/${uid} içinde email alanı yok`);

    assignedTo_uid = uid;
    assignedTo_email = email;
    // Kullanıcı adını al, yoksa email'i kullan
    if (userData.displayName) assignedTo_name = userData.displayName;
    else if (userData.name) assignedTo_name = userData.name;
    else assignedTo_name = email;

    logger.log("👤 Approval assignee resolved", { assignedTo_uid, assignedTo_email, assignedTo_name });
  } catch (e) {
    logger.error("❌ Assignee resolve error:", e);
    throw e instanceof HttpsError ? e : new HttpsError("internal", "Atama belirlenemedi", e?.message || String(e));
  }

  try {
    // 2) Uygun IP kayıtlarını tara
    const allIpRecordsSnap = await adminDb.collection('ipRecords').get();
    const candidates = [];
    let recordsProcessed = 0;

    for (const doc of allIpRecordsSnap.docs) {
      const ipRecord = doc.data();
      const ipRecordId = doc.id;
      recordsProcessed++;

      // Filtreler
      if (ipRecord.status === 'geçersiz' || ipRecord.status === 'rejected') continue;
      if ((ipRecord.wipoIR || ipRecord.aripoIR) && ipRecord.transactionHierarchy !== 'parent') continue;

      // Yenileme tarihi hesapla
      let renewalDate = null;
      if (ipRecord.renewalDate) {
        if (typeof ipRecord.renewalDate?.toDate === 'function') renewalDate = ipRecord.renewalDate.toDate();
        else if (typeof ipRecord.renewalDate === 'string') renewalDate = parseTurkishDate(ipRecord.renewalDate);
        else if (ipRecord.renewalDate instanceof Date) renewalDate = !isNaN(ipRecord.renewalDate.getTime()) ? ipRecord.renewalDate : null;
      }
      if (!renewalDate && ipRecord.applicationDate) {
        let appDate = null;
        if (typeof ipRecord.applicationDate?.toDate === 'function') appDate = ipRecord.applicationDate.toDate();
        else if (typeof ipRecord.applicationDate === 'string') appDate = parseTurkishDate(ipRecord.applicationDate);
        else if (ipRecord.applicationDate instanceof Date) appDate = !isNaN(ipRecord.applicationDate.getTime()) ? ipRecord.applicationDate : null;
        
        if (appDate) {
          const d = new Date(appDate);
          d.setFullYear(d.getFullYear() + 10);
          renewalDate = d;
        }
      }
      if (!renewalDate) continue;

      // Tarih aralığı kontrolü
      if (renewalDate < sixMonthsAgo || renewalDate > sixMonthsLater) continue;

      // Mevcut görev kontrolü
      const existing = await adminDb.collection('tasks')
        .where('relatedIpRecordId', '==', ipRecordId)
        .where('taskType', '==', taskTypeId)
        .where('status', 'in', ['awaiting_client_approval', 'open', 'in-progress'])
        .limit(1).get();
      if (!existing.empty) continue;

      // Tarih Hesaplamaları
      const rawOfficialDate = new Date(renewalDate);
      rawOfficialDate.setHours(0,0,0,0);

      const officialDate = findNextWorkingDay(rawOfficialDate, TURKEY_HOLIDAYS, { isWeekend, isHoliday });
      
      let operationalDate = new Date(officialDate);
      operationalDate.setDate(operationalDate.getDate() - 3);
      operationalDate.setHours(0,0,0,0);
      while (isWeekend(operationalDate) || isHoliday(operationalDate, TURKEY_HOLIDAYS)) {
        operationalDate.setDate(operationalDate.getDate() - 1);
      }

      const title = `${ipRecord.title} Marka Yenileme`;
      const description = `${ipRecord.title} adlı markanın yenileme süreci için müvekkil onayı bekleniyor. Yenileme tarihi: ${renewalDate.toLocaleDateString('tr-TR')}.`;

      // --- YENİ EKLENEN KISIM: Task Owner Belirleme ---
      const taskOwners = (Array.isArray(ipRecord.applicants) ? ipRecord.applicants : [])
          .map(a => String(a.id || a.personId))
          .filter(Boolean);
          
      // 🔥 YENİ: Denormalize için Applicant Name Bulma (Veritabanından asıl adı çekerek)
      let appName = "-";
      
      if (taskOwners.length > 0) {
          try {
              // İlk sahibin ID'sini kullanarak persons koleksiyonundan asıl adı çekiyoruz
              const personDoc = await adminDb.collection('persons').doc(taskOwners[0]).get();
              if (personDoc.exists) {
                  const pData = personDoc.data();
                  appName = pData.name || pData.companyName || "-";
              }
          } catch (e) {
              logger.warn('⚠️ Yenileme işi için kişi adı çekilemedi:', e);
          }
      }
      
      // Eğer DB'den bulunamazsa eski mantıkla yedek (fallback) kontrol
      if (appName === "-") {
          if (Array.isArray(ipRecord.applicants) && ipRecord.applicants.length > 0) {
              appName = ipRecord.applicants[0].name || "-";
          } else if (ipRecord.client && ipRecord.client.name) {
              appName = ipRecord.client.name;
          }
      }

      const data = {
        title,
        description,
        taskType: taskTypeId,
        relatedIpRecordId: ipRecordId,
        relatedIpRecordTitle: ipRecord.title,
        iprecordApplicationNo: ipRecord.applicationNumber || ipRecord.applicationNo || ipRecord.appNo || "-",
        iprecordTitle: ipRecord.title || ipRecord.markName || "-",
        iprecordApplicantName: appName,        
        taskOwner: taskOwners,
        
        status: 'awaiting_client_approval',
        priority: 'medium',
        dueDate: admin.firestore.Timestamp.fromDate(operationalDate),
        officialDueDate: admin.firestore.Timestamp.fromDate(officialDate),
        operationalDueDate: admin.firestore.Timestamp.fromDate(operationalDate),
        officialDueDateDetails: { /* ... detaylar ... */ }, 
        assignedTo_uid,
        assignedTo_email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        history: [{
          action: 'Yenileme görevi otomatik olarak oluşturuldu. Müvekkil onayı bekleniyor.',
          timestamp: new Date().toISOString(),
          userEmail: assignedTo_email || 'sistem@evrekapatent.com'
        }]
      };

      candidates.push(data);
    }

    if (candidates.length === 0) {
      logger.log(`ℹ️ Yeni oluşturulacak yenileme görevi yok. İşlenen kayıt: ${recordsProcessed}`);
      return { success: true, count: 0, taskIds: [], processed: recordsProcessed };
    }

    // 3) TEK TRANSACTION: Task ve Transaction Kaydı
    const result = await admin.firestore().runTransaction(async (tx) => {
      const counterRef = adminDb.collection('counters').doc('tasks');
      const counterSnap = await tx.get(counterRef);

      let lastId = 0;
      if (counterSnap.exists) {
        const data = counterSnap.data() || {};
        lastId = Number(data.lastId || 0);
        if (!Number.isFinite(lastId)) lastId = 0;
      } else {
        tx.set(counterRef, { lastId: 0 });
      }

      const newIds = [];
      const now = new Date();
      const nowISO = now.toISOString();
      const timestampObj = admin.firestore.Timestamp.fromDate(now); // Firestore Timestamp

      for (let i = 0; i < candidates.length; i++) {
        const nextId = (lastId + 1 + i).toString();
        const taskRef = adminDb.collection('tasks').doc(nextId);
        const taskData = candidates[i];
        
        // A) Task Kaydı
        tx.set(taskRef, { ...taskData, id: nextId });
        newIds.push(nextId);

        // B) Transaction Kaydı (İlişkili IP Kaydına) [İstenilen Format]
        if (taskData.relatedIpRecordId) {
            const transactionRef = adminDb
                .collection('ipRecords')
                .doc(taskData.relatedIpRecordId)
                .collection('transactions')
                .doc(); // Auto-ID

            const transactionData = {
                createdAt: timestampObj,       // (timestamp)
                description: "Yenileme işlemi.", // (string) - Sabit metin
                timestamp: nowISO,             // (string) - ISO format
                transactionHierarchy: "parent",// (string)
                taskId: String(nextId),      // (string)
                type: "22",                    // (string)
                userEmail: assignedTo_email,   // (string)
                userId: assignedTo_uid,        // (string)
                userName: assignedTo_name      // (string) - Çekilen isim
            };

            tx.set(transactionRef, transactionData);
        }
      }

      const finalLastId = lastId + candidates.length;
      tx.set(counterRef, { lastId: finalLastId }, { merge: true });

      return { success: true, count: candidates.length, taskIds: newIds, processed: recordsProcessed };
    });

    logger.log(`✅ ${result.count} adet yenileme görevi ve transaction kaydı oluşturuldu.`);
    return result;

  } catch (error) {
    logger.error("Renewal task creation failed", error);
    throw new HttpsError('internal', 'Yenileme süreçleri oluşturulurken hata.', error.message || String(error));
  }
});


// functions/index.js - createClientNotificationOnRenewalTaskCreated (KONU FORMATI DÜZELTİLDİ)

export const createClientNotificationOnRenewalTaskCreated = onDocumentCreated(
  { document: "tasks/{taskId}", region: "europe-west1" },
  async (event) => {
    const snap = event.data;
    const task = snap?.data() || {};
    const taskId = event.params.taskId;

    // Sadece 'Yenileme' (22) ve 'Müvekkil Onayı Bekliyor'
    if (String(task.taskType) !== "22") return null;
    if (task.status !== "awaiting_client_approval") return null;

    try {
      // 1. IP Kaydı
      const relatedIpRecordId = task.relatedIpRecordId;
      if (!relatedIpRecordId) return null;

      const ipRef = adminDb.collection("ipRecords").doc(relatedIpRecordId);
      const ipDoc = await ipRef.get();
      if (!ipDoc.exists) return null;

      const ipData = ipDoc.data() || {};
      const rawApplicants = ipData.applicants || [];

      // 2. Alıcılar
      const notificationType = (task.mainProcessType || "marka");
      const { to: toList = [], cc: ccList = [] } = await getRecipientsByApplicantIds(rawApplicants, notificationType);

      // --- VERİ HAZIRLIĞI ---
      
      // A) Başvuru Sahipleri (Person ID -> Name)
      let applicantNames = "-";
      try {
          const namesList = [];
          for (const rawApp of rawApplicants) {
              if (rawApp.id) {
                  const personDoc = await adminDb.collection("persons").doc(rawApp.id).get();
                  if (personDoc.exists) {
                      const pData = personDoc.data();
                      namesList.push(pData.name || pData.companyName || "-");
                  }
              }
          }
          if (namesList.length > 0) applicantNames = namesList.join(", ");
      } catch (err) {
          console.error("Applicant fetch error:", err);
      }

      // B) Sınıflar
      let classNumbers = "-";
      if (ipData.goodsAndServicesByClass && Array.isArray(ipData.goodsAndServicesByClass)) {
          classNumbers = ipData.goodsAndServicesByClass
            .map(item => item.classNo)
            .filter(Boolean)
            .join(", ");
      }

      // C) Tarih Formatlama
      const formatDate = (val) => {
        if (!val) return "-";
        const date = (val.toDate) ? val.toDate() : new Date(val);
        if (isNaN(date.getTime())) return "-";
        return date.toLocaleDateString("tr-TR");
      };
      const renewalDateText = formatDate(ipData.protectionEndDate || ipData.renewalDate);

      // D) Temel Alanlar
      const appNo = ipData.applicationNumber || ipData.applicationNo || ipData.appNo || "-";
      const markName = ipData.title || ipData.markName || "-";

      // --- E) KONU (İSTEĞE GÖRE GÜNCELLENDİ) ---
      // Format: 2006/04203 - "emaar şekil" - Marka Yenileme İşlemi / Talimat Bekleniyor
      let subject = `${appNo} - "${markName}" - Marka Yenileme İşlemi / Talimat Bekleniyor`;
      
      let body = task.description || "Yenileme işlemi için onayınızı rica ederiz.";
      body = body.replace(/\n/g, '<br>');

      // F) Şablon Yönetimi
      let templateId = null; 

      try {
        const ruleSnap = await adminDb.collection("template_rules")
          .where("sourceType", "==", "task")
          .where("taskType", "==", "22")
          .limit(1)
          .get();

        if (!ruleSnap.empty) {
          templateId = ruleSnap.docs[0].data()?.templateId || null;

          if (templateId) {
            const templateSnap = await adminDb.collection("mail_templates").doc(templateId).get();
            if (templateSnap.exists) {
              const tmplData = templateSnap.data();
              
              // Eğer şablonda bir konu (subject) tanımlıysa onu al, yoksa yukarıdaki varsayılanı kullan
              let rawSubject = tmplData.subject || subject;
              let rawBody = tmplData.body || body;

              const isHtml = rawBody && (rawBody.includes("<html") || rawBody.includes("<body"));
              if (rawBody && !isHtml) {
                  rawBody = rawBody.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
              }

              // Görsel URL
              const clean = (val) => (val ? String(val).trim() : "");
              const markImageUrl = 
                clean(ipData.brandImageUrl) || 
                clean(ipData.trademarkImage) || 
                clean(ipData.publicImageUrl) || 
                clean(ipData.imageUrl) || 
                clean(ipData.imageSignedUrl) || 
                "";

              // --- DEĞİŞKENLER ---
              const replacements = {
                "{{applicationNo}}": appNo,
                "{{markName}}": markName,
                "{{markImageUrl}}": markImageUrl,
                "{{relatedIpRecordTitle}}": markName,
                "{{applicantNames}}": applicantNames,
                "{{classNumbers}}": classNumbers,
                "{{renewalDate}}": renewalDateText
              };

              Object.keys(replacements).forEach(key => {
                 const val = replacements[key];
                 rawSubject = rawSubject.split(key).join(val);
                 rawBody = rawBody.split(key).join(val);
              });

              subject = rawSubject;
              body = rawBody;
            }
          }
        }
      } catch (e) {
        console.warn("Template hatası:", e);
      }

      // 4. Kayıt
      const hasRecipients = (toList.length + ccList.length) > 0;
      const missingFields = [];
      if (!hasRecipients) missingFields.push("recipients");
      if (!templateId) missingFields.push("template");
      
      const finalStatus = missingFields.length ? "missing_info" : "awaiting_client_approval";

      const notificationDoc = {
        toList, ccList,
        clientId: task.clientId || (rawApplicants?.[0]?.id || null),
        subject, body, status: finalStatus,
        mode: "draft", isDraft: true,
        assignedTo_uid: task.assignedTo_uid || null,
        assignedTo_email: task.assignedTo_email || null,
        relatedIpRecordId, associatedTaskId: taskId,
        templateId, notificationType, source: "task_renewal_auto",
        taskType: task.taskType || null,
        missingFields,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await adminDb.collection("mail_notifications").add(notificationDoc);
      return null;
    } catch (err) {
      console.error("Hata:", err);
      return null;
    }
  }
);

// ===== similaritySearchWorker (Pub/Sub Abonesi) =====
export const similaritySearchWorker = onMessagePublished(
  {
    topic: 'similarity-search-jobs',
    region: 'europe-west1',
    memory: '2GiB', // <--- KRİTİK: Ağ hızı için 2GB şart
    timeoutSeconds: 540,
  },
  async (event) => {
    const payload = event?.data?.message?.json || {};
    const { jobId, monitoredMarks, selectedBulletinId, workerId, startIndex } = payload;

    if (!jobId || !Array.isArray(monitoredMarks) || !selectedBulletinId) {
      logger.warn('⚠️ similaritySearchWorker: eksik payload', payload);
      return null;
    }

    const currentStartIndex = startIndex || 0;

    // Worker durumunu güncelle
    await adminDb.collection('searchProgress').doc(jobId)
        .collection('workers').doc(String(workerId)).set({
            status: currentStartIndex === 0 ? 'starting' : 'resuming',
            progress: 0, 
            processed: currentStartIndex,
            total: monitoredMarks.length,
            lastUpdate: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

    try {
      await processSearchInBackground(jobId, monitoredMarks, selectedBulletinId, currentStartIndex, workerId);
      return null;
    } catch (err) {
      await adminDb.collection('searchProgress').doc(jobId)
        .collection('workers').doc(String(workerId)).update({
            status: 'error',
            error: err.message
        });
      return null;
    }
  }
);

/**
 * Monitored Marka ID'si üzerinden en ilişkili IP Kaydını ve Client ID'sini bulur.
 */

export const handleBulletinDeletion = onMessagePublished(
  { topic: 'bulletin-deletion', region: 'europe-west1', memory: '1GiB', cpu: 1, timeoutSeconds: 540 },
  async (event) => {
    console.log('🎯 handleBulletinDeletion triggered');
    console.log('📨 Event data:', JSON.stringify(event.data, null, 2));
    
    const { bulletinId, operationId } = event.data.message.json || {};
    if (!bulletinId || !operationId) {
      console.warn('⚠️ handleBulletinDeletion: eksik payload', {
        bulletinId,
        operationId,
        rawJson: event?.data?.message?.json
      });
      return null;
    }
    
    console.log(`🚀 Starting bulletin deletion: bulletinId=${bulletinId}, operationId=${operationId}`);
    
    try {
      await performBulletinDeletion(bulletinId, operationId);
      console.log(`✅ Bulletin deletion completed: ${bulletinId}`);
    } catch (e) {
      console.error('💥 handleBulletinDeletion failed:', {
        bulletinId,
        operationId,
        error: e?.message || e,
        stack: e?.stack
      });
      
      // Hata durumunu operationStatus'a yaz
      try {
        const statusRef = db.collection('operationStatus').doc(operationId);
        await statusRef.update({
          status: 'error',
          message: `Handler hatası: ${e?.message || e}`,
          endTime: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (statusError) {
        console.error('Status update failed:', statusError);
      }
    }
    return null;
  }
);
// =========================================================
//              TASK OTOMASYON TRIGGERLARI
// =========================================================

// 1. FONKSİYON: Statüyü "Açık" Yap (GÜÇLENDİRİLMİŞ VERSİYON)
export const activateAccrualTaskOnCompletionV2 = onDocumentUpdated(
  {
    document: "tasks/{taskId}",
    region: "europe-west1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return null;

    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const taskId = event.params.taskId;

    // Sadece statü "completed" (Bitti) olduğunda çalış
    if (before.status === after.status || after.status !== "completed") {
      return null;
    }

    console.log(`✅ Ana iş tamamlandı (${taskId}). Bağlı tahakkuk görevleri esnek sorguyla aranıyor...`);

    try {
      // SADECE 'relatedTaskId' ile sorgula (En güvenli yöntem)
      // taskType veya status sorgusunu kod içinde yapacağız (Data Type hatasını önlemek için)
      const snapshot = await adminDb
        .collection("tasks")
        .where("relatedTaskId", "==", taskId)
        .get();

      if (snapshot.empty) {
        console.log("ℹ️ Bu işe bağlı hiçbir alt görev bulunamadı.");
        return null;
      }

      const batch = adminDb.batch();
      let count = 0;

      snapshot.forEach((doc) => {
        const data = doc.data();
        
        // KONTROLLERİ BURADA YAPIYORUZ:
        // 1. taskType '53' mü? (Hem string "53" hem sayı 53 kabul et)
        // 2. Statü 'pending' (Beklemede) mi?
        const isAccrualTask = String(data.taskType) === "53";
        const isPending = data.status === "pending";

        if (isAccrualTask && isPending) {
          console.log(`🎯 Hedef tahakkuk görevi bulundu: ${doc.id}`);
          
          batch.update(doc.ref, { 
            status: "open",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            history: admin.firestore.FieldValue.arrayUnion({
              action: 'Ana iş tamamlandığı için statü "Açık" olarak güncellendi.',
              timestamp: new Date().toISOString(),
              user: 'system'
            })
          });
          count++;
        }
      });

      if (count > 0) {
        await batch.commit();
        console.log(`🚀 ${count} adet tahakkuk görevi başarıyla "Açık" statüsüne çekildi.`);
      } else {
        console.log("ℹ️ Bağlı görevler var ama 'Beklemede' olan bir 'Tahakkuk Oluşturma' işi yok.");
      }

    } catch (error) {
      console.error("❌ Tahakkuk görevi güncellenirken hata:", error);
    }

    return null;
  }
);

// 2. FONKSİYON: Statüyü "Beklemede" Yap (Geri Al)
export const revertAccrualTaskOnReopeningV2 = onDocumentUpdated(
  {
    document: "tasks/{taskId}",
    region: "europe-west1",
  },
  async (event) => {
    // ... (başlangıç aynı) ...
    const change = event.data;
    if (!change || !change.before || !change.after) return null;
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const taskId = event.params.taskId;

    if (before.status === "completed" && after.status !== "completed") {
      try {
        // DEĞİŞİKLİK BURADA: taskType '53' oldu
        const snapshot = await adminDb
          .collection("tasks")
          .where("relatedTaskId", "==", taskId)
          .where("taskType", "==", "53")
          .where("status", "==", "open") 
          .get();

        if (snapshot.empty) return null;

        const batch = adminDb.batch();
        snapshot.forEach((doc) => {
          batch.update(doc.ref, { 
            status: "pending",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            history: admin.firestore.FieldValue.arrayUnion({
              action: 'Ana iş geri alındığı için statü "Beklemede" yapıldı.',
              timestamp: new Date().toISOString(),
              user: 'system'
            })
          });
        });
        await batch.commit();
      } catch (error) { console.error("Error:", error); }
    }
    return null;
  }
);

export const createAccrualTaskOnClientApprovalV2 = onDocumentUpdated(
  {
    document: "tasks/{taskId}",
    region: "europe-west1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return null;

    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const taskId = event.params.taskId;

    // KURAL: Statü "Müvekkil Onayı Bekliyor"dan "Açık"a döndü mü?
    const wasAwaiting = ['awaiting_client_approval', 'awaiting-approval'].includes(before.status);
    const isOpen = after.status === 'open';

    if (wasAwaiting && isOpen) {
      try {
        console.log(`🔔 Task ${taskId} onaylandı. ID üretiliyor...`);

        // --- 1. ATAMA MANTIĞI (DB'den veya Varsayılan) ---
        let assignedUid = "788e10fb-f137-4a78-b03d-840b14a14b87"; // Varsayılan (Selcan Hn.)
        let assignedEmail = "selcanakoglu@evrekapatent.com";

        try {
            const assignmentDoc = await adminDb.collection('taskAssignments').doc('53').get();
            if (assignmentDoc.exists) {
                const data = assignmentDoc.data();
                if (data.assigneeIds && data.assigneeIds.length > 0) {
                    assignedUid = data.assigneeIds[0];
                    // Kullanıcının güncel emailini çek
                    const userDoc = await adminDb.collection('users').doc(assignedUid).get();
                    if (userDoc.exists) assignedEmail = userDoc.data().email;
                }
            }
        } catch (e) { console.error("Atama kuralı hatası:", e); }

        // --- 2. ID ÜRETİMİ (T-XX) ---
        const counterRef = adminDb.collection('counters').doc('tasks_accruals');
        const newCustomId = await adminDb.runTransaction(async (t) => {
            const doc = await t.get(counterRef);
            const currentCount = doc.exists ? (doc.data().count || 0) : 0;
            const newCount = currentCount + 1;
            t.set(counterRef, { count: newCount }, { merge: true });
            return `T-${newCount}`;
        });

        // --- 3. VERİ HAZIRLIĞI ---
        const now = new Date().toISOString(); 
        
        const creatorUid = after.updatedBy_uid || after.updatedBy || 'system'; 
        const creatorEmail = after.updatedBy_email || 'system@evrekapatent.com';

        const originalType = after.taskTypeName || after.taskType || 'Bilinmiyor';

        const accrualTaskData = {
          id: newCustomId, 
          taskType: "53",
          title: `Tahakkuk Oluşturma: ${after.title || ''}`,
          description: `"${after.title || ''}" işi oluşturuldu ancak tahakkuk verisi girilmedi. Lütfen finansal kaydı oluşturun.`,
          priority: 'high',
          status: 'pending',
          assignedTo_uid: assignedUid,
          assignedTo_email: assignedEmail,
          relatedTaskId: taskId,
          relatedIpRecordId: after.relatedIpRecordId || null,
          relatedIpRecordTitle: after.relatedIpRecordTitle || after.title,
          iprecordApplicationNo: after.iprecordApplicationNo || "-",
          iprecordTitle: after.iprecordTitle || after.relatedIpRecordTitle || after.title || "-",
          iprecordApplicantName: after.iprecordApplicantName || "-",
          createdAt: now,
          updatedAt: now,
          createdBy: { uid: creatorUid, email: creatorEmail },
          details: { source: 'automatic_accrual_assignment', originalTaskType: originalType },
          history: [{ action: "İş oluşturuldu.", timestamp: now, userEmail: creatorEmail }]
        };

        // --- 4. KAYIT ---
        await adminDb.collection('tasks').doc(newCustomId).set(accrualTaskData);
        console.log(`✅ Tahakkuk görevi başarıyla oluşturuldu: ${newCustomId}`);
        
      } catch (error) {
        console.error("Error creating accrual task:", error);
      }

      // --- 5. ANA İŞİN SAHİBİNİ GÜNCELLEME (RE-ASSIGNMENT) ---
      try {
          const currentTaskType = String(after.taskType); 
          const ruleRef = adminDb.collection('taskAssignments').doc(currentTaskType);
          const ruleSnap = await ruleRef.get();

          if (ruleSnap.exists) {
              const ruleData = ruleSnap.data();
              const targetAssigneeId = (ruleData.assigneeIds && ruleData.assigneeIds.length > 0) ? ruleData.assigneeIds[0] : null;

              if (targetAssigneeId && targetAssigneeId !== after.assignedTo_uid) {
                  let targetEmail = "";
                  const userSnap = await adminDb.collection('users').doc(targetAssigneeId).get();
                  if (userSnap.exists) targetEmail = userSnap.data().email;

                  console.log(`🔄 İş Açıldı: Görev (Tip ${currentTaskType}) yeniden atanıyor -> ${targetEmail}`);

                  await adminDb.collection('tasks').doc(taskId).update({
                      assignedTo_uid: targetAssigneeId,
                      assignedTo_email: targetEmail,
                      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                      history: admin.firestore.FieldValue.arrayUnion({
                          action: `İş açıldı ve kural gereği yeniden atandı: ${targetEmail}`,
                          timestamp: new Date().toISOString(),
                          userEmail: 'system'
                      })
                  });
              }
          }
      } catch (reassignErr) {
          console.error("❌ Re-assignment hatası:", reassignErr);
      }

      // --- [YENİ] MÜVEKKİLE "İŞLEM BAŞLATILIYOR" BİLDİRİMİ ---
      // Bu bölüm, işi onayladıklarında otomatik olarak "Talimatınız alındı" maili gönderir.
      try {
          console.log(`📧 Task ${taskId} onaylandı. Müvekkil bilgilendirme maili hazırlanıyor...`);

          // A) Şablonu Çek
          const templateSnap = await adminDb.collection("mail_templates").doc("tmpl_clientInstruction_1").get();
          
          if (templateSnap.exists) {
              const tmpl = templateSnap.data();
              let subject = tmpl.subject || "{{relatedIpRecordTitle}} - Talimatınız Alındı";
              let body = tmpl.body || "<p>Talimatınız alınmıştır, işlem başlatılıyor.</p>";

              // B) Değişkenleri Yerleştir ve ZİNCİRLEME (Threading) Yap
              const relatedTitle = after.relatedIpRecordTitle || after.title || "Dosya";
              let resolvedSubject = subject.replace(/{{relatedIpRecordTitle}}/g, relatedTitle);
              let resolvedBody = body.replace(/{{relatedIpRecordTitle}}/g, relatedTitle);

              // THREADING: V2'deki gibi rootSubject'i bulup zorlama
              if (after.relatedIpRecordId && after.taskType) {
                  try {
                      const threadKey = `${after.relatedIpRecordId}_${after.taskType}`;
                      const threadDoc = await adminDb.collection("mailThreads").doc(threadKey).get();
                      
                      if (threadDoc.exists && threadDoc.data()?.rootSubject) {
                          const rootSubject = threadDoc.data().rootSubject;
                          
                          // Konu kutusunu oluştur
                          const innerSubjectHtml = `
                            <div style="background-color: #f8f9fa; border-left: 4px solid #1a73e8; padding: 15px; margin: 0 0 20px 0; font-family: Arial, sans-serif; color: #333; font-size: 14px;">
                                <strong style="color: #1a73e8;">KONU:</strong> ${resolvedSubject}
                            </div>
                          `;
                          
                          // 1. Konuyu ana thread konusuyla ez (iç içe girmesi için)
                          resolvedSubject = rootSubject;

                          // 2. Alt konuyu body'nin içine enjekte et
                          if (resolvedBody.toLowerCase().includes("<body")) {
                              resolvedBody = resolvedBody.replace(/<body[^>]*>/i, (match) => match + innerSubjectHtml);
                          } else {
                              resolvedBody = innerSubjectHtml + resolvedBody;
                          }
                          console.log(`🔗 [THREADING] Instruction 1 maili '${rootSubject}' zincirine bağlandı.`);
                      }
                  } catch (e) {
                      console.error("Threading hatası:", e);
                  }
              }
              
              subject = resolvedSubject;
              body = resolvedBody;

              // C) Alıcıları Belirle (Gelişmiş Mantık) ---
              let finalTo = [];
              let finalCc = [];

              if (after.relatedIpRecordId) {
                  try {
                      const ipDoc = await adminDb.collection('ipRecords').doc(after.relatedIpRecordId).get();
                      if (ipDoc.exists) {
                          const ipData = ipDoc.data();
                          
                          // 🔥 GÜVENLİK DUVARI: Rakibe Mail Atmayı Engelle
                          const isThirdParty = ipData.recordOwnerType === 'third_party';
                          let targetPersonsForEmail = [];

                          if (isThirdParty) {
                              // Üçüncü tarafsa (itiraz vs.) 'applicants' rakibi temsil eder, ASLA KULLANMA.
                              // Görevi talep eden kendi müvekkilini (taskOwner / clientId) kullan.
                              let owners = after.taskOwner || after.taskOwnerIds || after.clientId || [];
                              if (typeof owners === 'string') owners = [owners];
                              targetPersonsForEmail = owners.map(id => ({ id }));
                          } else {
                              // Kendi markamızsa, normal applicants kullanabiliriz.
                              targetPersonsForEmail = ipData.applicants || [];
                          }
                          
                          // 1. Müvekkil Sorumlularını ve Bildirim Ayarlarını Çöz
                          const resolvedRecipients = await getRecipientsByApplicantIds(targetPersonsForEmail, "marka");
                          finalTo = resolvedRecipients.to || [];
                          finalCc = resolvedRecipients.cc || [];

                          // 2. Evreka Global CC Listesini Ekle (İşlem Tipine Göre)
                          const extraCc = await getCcFromEvrekaListByTransactionType(after.taskType);
                          finalCc = [...new Set([...finalCc, ...(extraCc || [])])];
                      }
                  } catch (err) {
                      console.error("Alıcı çözme hatası:", err);
                  }
              }

              // Fallback: Eğer hala hiç alıcı yoksa manuel alanlara bak
              if (finalTo.length === 0) {
                  if (after.clientEmail) finalTo.push(after.clientEmail);
                  if (after.details?.relatedParty?.email) finalTo.push(after.details.relatedParty.email);
              }

              const dedupe = (arr) => Array.from(new Set(arr.filter(e => e && e.trim() !== "")));
              finalTo = dedupe(finalTo);
              finalCc = dedupe(finalCc).filter(e => !finalTo.includes(e));

              const missingFields = [];
              if (finalTo.length === 0) missingFields.push("recipients");

              const notificationStatus = missingFields.length > 0 ? "missing_info" : "pending";

              await adminDb.collection("mail_notifications").add({
                  toList: finalTo,
                  ccList: finalCc,
                  recipientTo: finalTo, // UI Görünürlüğü için
                  recipientCc: finalCc, // UI Görünürlüğü için
                  subject: subject,
                  body: body,
                  status: notificationStatus,
                  missingFields: missingFields,
                  
                  // THREADING VERİLERİ
                  notificationType: "general_notification",
                  taskType: String(after.taskType),
                  relatedIpRecordId: after.relatedIpRecordId,
                  associatedTaskId: taskId,
                  
                  source: "auto_instruction_response",
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });

              if (notificationStatus === "missing_info") {
                  console.log(`⚠️ [AUTO-REPLY] Alıcı bulunamadı. 'Eksik Bilgi' statüsünde bildirim oluşturuldu.`);
              } else {
                  console.log(`✅ [AUTO-REPLY] 'İşlem Başlatılıyor' maili kuyruğa eklendi.`);
              }

          }
      } catch (mailErr) {
          console.error("❌ Müvekkil bilgilendirme maili hatası:", mailErr);
      }

    }
    return null;
  }
);

export const onTaskDeleteCleanup = onDocumentDeleted(
  {
    document: "tasks/{taskId}",
    region: "europe-west1",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const taskId = event.params.taskId;
    const taskData = snap.data();
    
    // adminDb'yi dosyanızın genelinden alıyoruz
    const batch = adminDb.batch();
    const bucket = admin.storage().bucket();

    console.log(`🗑️ Task ${taskId} silindi. İlişkili veriler temizleniyor...`);

    try {
      // 1. TAHAKKUKLARI SİL (accruals)
      const accrualsSnapshot = await adminDb.collection('accruals').where('taskId', '==', taskId).get();
      accrualsSnapshot.forEach((doc) => batch.delete(doc.ref));
      console.log(`- ${accrualsSnapshot.size} tahakkuk silinecek.`);

      // 2. ALT GÖREVLERİ SİL (tasks)
      const childTasksSnapshot = await adminDb.collection('tasks').where('relatedTaskId', '==', taskId).get();
      childTasksSnapshot.forEach((doc) => batch.delete(doc.ref));
      console.log(`- ${childTasksSnapshot.size} alt görev silinecek.`);

      // 3. DAVA KAYITLARINI SİL (suits)
      const suitsSnapshot = await adminDb.collection('suits').where('relatedTaskId', '==', taskId).get();
      suitsSnapshot.forEach((doc) => batch.delete(doc.ref));
      console.log(`- ${suitsSnapshot.size} dava kaydı silinecek.`);

      // 4. BİLDİRİMLERİ SİL (notifications)
      const notificationsSnapshot = await adminDb.collection('notifications').where('relatedTaskId', '==', taskId).get();
      notificationsSnapshot.forEach((doc) => batch.delete(doc.ref));

      // 5. TRANSACTION GEÇMİŞİNİ SİL (ipRecords -> transactions SUBCOLLECTION) [GÜNCELLENDİ]
      if (taskData.relatedIpRecordId) {
        // Doğru yol: ipRecords/{id}/transactions
        const transactionsRef = adminDb
            .collection('ipRecords')
            .doc(taskData.relatedIpRecordId)
            .collection('transactions');

        // A) SİLİNEN TASK TARAFINDAN OLUŞTURULAN TRANSACTION'I BUL
        const transactionSnapshot = await transactionsRef
            .where('taskId', '==', taskId) // 🔥 SADECE taskId
            .get();

        if (!transactionSnapshot.empty) {
            const deletedTransactionIds = [];

            // Ana transaction'ı sil
            transactionSnapshot.forEach((doc) => {
                console.log(`📌 Silinecek Transaction Bulundu (ID: ${doc.id})`);
                batch.delete(doc.ref);
                deletedTransactionIds.push(doc.id);
            });

            // B) EĞER BU BİR PARENT TRANSACTION İSE, CHILD'LARINI DA BUL VE SİL
            if (deletedTransactionIds.length > 0) {
                // parentId'si silinenlerden biri olan child transaction'ları bul
                const childTransactionsSnapshot = await transactionsRef
                    .where('parentId', 'in', deletedTransactionIds)
                    .get();

                childTransactionsSnapshot.forEach((childDoc) => {
                    console.log(`-- 🔗 Bağlı Child Transaction da siliniyor (ID: ${childDoc.id})`);
                    batch.delete(childDoc.ref);
                });
            }
        }
      }

      // 6. FİZİKSEL DOSYALARI SİL (Storage)
      if (taskData.files && Array.isArray(taskData.files) && taskData.files.length > 0) {
        const fileDeletions = taskData.files.map(async (file) => {
          let pathToDelete = file.storagePath;

          if (!pathToDelete && file.url) {
             try {
                 const decodedUrl = decodeURIComponent(file.url);
                 const startIndex = decodedUrl.indexOf('/o/') + 3;
                 const endIndex = decodedUrl.indexOf('?');
                 if(startIndex > 2 && endIndex > startIndex) {
                     pathToDelete = decodedUrl.substring(startIndex, endIndex);
                 }
             } catch(e) { console.warn("Dosya yolu ayrıştırılamadı:", file.url); }
          }

          if (pathToDelete) {
             try {
                await bucket.file(pathToDelete).delete();
                console.log(`-- Dosya silindi: ${pathToDelete}`);
             } catch (error) {
                if (error.code !== 404) console.error(`Dosya silme hatası:`, error.message);
             }
          }
        });
        Promise.all(fileDeletions).catch(err => console.error("Dosya silme hatası:", err));
      }

      // 7. BATCH İŞLEMİNİ UYGULA
      await batch.commit();
      console.log(`✅ Temizlik Tamamlandı: Task ${taskId} verileri silindi.`);

    } catch (error) {
      console.error(`❌ Temizlik hatası:`, error);
    }
  }
);

export const cleanupTransactionOnClientRejection = onDocumentUpdated(
  {
    document: "tasks/{taskId}",
    region: "europe-west1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return null;

    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const taskId = event.params.taskId;

    console.log(`🔍 [DEBUG] Task ${taskId} güncellendi. Statü Geçişi: '${before.status}' -> '${after.status}'`);

    const wasAwaiting = ['awaiting_client_approval', 'awaiting-approval'].includes(before.status);
    const isClosedOrNoResponse = [
        'client_approval_closed', 
        'client_no_response_closed'
    ].includes(after.status);

    if (wasAwaiting && isClosedOrNoResponse) {
        console.log(`🚫 Task ${taskId} kapatıldı. İşlemler başlıyor...`);

        const batch = adminDb.batch();
        
        // --- 1. TRANSACTION TEMİZLİĞİ ---
        try {
            if (after.relatedIpRecordId) {
                const transactionsRef = adminDb.collection('ipRecords').doc(after.relatedIpRecordId).collection('transactions');
                const transactionSnapshot = await transactionsRef.where('taskId', '==', taskId).get();

                if (!transactionSnapshot.empty) {
                    const deletedTransactionIds = [];
                    transactionSnapshot.forEach((doc) => {
                        batch.delete(doc.ref);
                        deletedTransactionIds.push(doc.id);
                    });

                    if (deletedTransactionIds.length > 0) {
                        const childTransactionsSnapshot = await transactionsRef.where('parentId', 'in', deletedTransactionIds).get();
                        childTransactionsSnapshot.forEach((childDoc) => {
                            batch.delete(childDoc.ref);
                        });
                    }
                    await batch.commit();
                    console.log(`✅ Temizlik Tamamlandı.`);
                }
            }
        } catch (error) {
            console.error("❌ Transaction temizliği hatası:", error);
        }

        // --- 2. MÜVEKKİLE "DOSYA KAPATILDI" MAİLİ GÖNDERME ---
        try {
            console.log(`📧 Kapanış bilgilendirme maili hazırlanıyor...`);

            // A) Şablonu Çek
            const templateSnap = await adminDb.collection("mail_templates").doc("tmpl_clientInstruction_2").get();
            
            if (templateSnap.exists) {
                const tmpl = templateSnap.data();
                let subject = tmpl.subject || "{{relatedIpRecordTitle}} - Dosya Kapatıldı";
                let body = tmpl.body || "<p>Talimatınız üzerine dosya kapatılmıştır.</p>";

                // B) Değişkenleri Yerleştir ve ZİNCİRLEME (Threading) Yap
                const relatedTitle = after.relatedIpRecordTitle || after.title || "Dosya";
                let resolvedSubject = subject.replace(/{{relatedIpRecordTitle}}/g, relatedTitle);
                let resolvedBody = body.replace(/{{relatedIpRecordTitle}}/g, relatedTitle);

                // THREADING: V2'deki gibi rootSubject'i bulup zorlama
                if (after.relatedIpRecordId && after.taskType) {
                    try {
                        const threadKey = `${after.relatedIpRecordId}_${after.taskType}`;
                        const threadDoc = await adminDb.collection("mailThreads").doc(threadKey).get();
                        
                        if (threadDoc.exists && threadDoc.data()?.rootSubject) {
                            const rootSubject = threadDoc.data().rootSubject;
                            
                            const innerSubjectHtml = `
                              <div style="background-color: #f8f9fa; border-left: 4px solid #1a73e8; padding: 15px; margin: 0 0 20px 0; font-family: Arial, sans-serif; color: #333; font-size: 14px;">
                                  <strong style="color: #1a73e8;">KONU:</strong> ${resolvedSubject}
                              </div>
                            `;
                            
                            resolvedSubject = rootSubject;

                            if (resolvedBody.toLowerCase().includes("<body")) {
                                resolvedBody = resolvedBody.replace(/<body[^>]*>/i, (match) => match + innerSubjectHtml);
                            } else {
                                resolvedBody = innerSubjectHtml + resolvedBody;
                            }
                            console.log(`🔗 [THREADING] Instruction 2 maili '${rootSubject}' zincirine bağlandı.`);
                        }
                    } catch (e) {
                        console.error("Threading hatası:", e);
                    }
                }
                
                subject = resolvedSubject;
                body = resolvedBody;

                // C) Alıcı Belirle (Gelişmiş Mantık) ---
                let finalTo = [];
                let finalCc = [];

                if (after.relatedIpRecordId) {
                    try {
                        const ipDoc = await adminDb.collection('ipRecords').doc(after.relatedIpRecordId).get();
                        if(ipDoc.exists) {
                            const ipData = ipDoc.data();
                            
                            // 🔥 GÜVENLİK DUVARI: Rakibe Mail Atmayı Engelle
                            const isThirdParty = ipData.recordOwnerType === 'third_party';
                            let targetPersonsForEmail = [];

                            if (isThirdParty) {
                                let owners = after.taskOwner || after.taskOwnerIds || after.clientId || [];
                                if (typeof owners === 'string') owners = [owners];
                                targetPersonsForEmail = owners.map(id => ({ id }));
                            } else {
                                targetPersonsForEmail = ipData.applicants || [];
                            }
                            
                            // 1. Sorumlu ve Notify ayarlarını çöz
                            const resolvedRecipients = await getRecipientsByApplicantIds(targetPersonsForEmail, "marka");
                            finalTo = resolvedRecipients.to || [];
                            finalCc = resolvedRecipients.cc || [];

                            // 2. Global CC listesini ekle
                            const extraCc = await getCcFromEvrekaListByTransactionType(after.taskType);
                            finalCc = [...new Set([...finalCc, ...(extraCc || [])])];
                        }
                    } catch (err) { console.error("Mail bulma hatası:", err); }
                }
                if (finalTo.length === 0) {
                    if (after.clientEmail) finalTo.push(after.clientEmail);
                    if (after.details?.relatedParty?.email) finalTo.push(after.details.relatedParty.email);
                }

                const dedupe = (arr) => Array.from(new Set(arr.filter(e => e && e.trim() !== "")));
                finalTo = dedupe(finalTo);
                finalCc = dedupe(finalCc).filter(e => !finalTo.includes(e));

                const missingFields = [];
                if (finalTo.length === 0) missingFields.push("recipients");

                const notificationStatus = missingFields.length > 0 ? "missing_info" : "pending";

                await adminDb.collection("mail_notifications").add({
                    toList: finalTo,
                    ccList: finalCc,
                    recipientTo: finalTo, // UI Görünürlüğü için
                    recipientCc: finalCc, // UI Görünürlüğü için
                    subject: subject,
                    body: body,
                    status: notificationStatus,
                    missingFields: missingFields,
                    notificationType: "general_notification",
                    taskType: String(after.taskType),
                    relatedIpRecordId: after.relatedIpRecordId,
                    associatedTaskId: taskId,
                    source: "auto_instruction_response",
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                if (notificationStatus === "missing_info") {
                    console.log(`⚠️ [AUTO-REPLY] Alıcı bulunamadı. 'Eksik Bilgi' statüsünde bildirim oluşturuldu.`);
                } else {
                    console.log(`✅ [AUTO-REPLY] 'Dosya Kapatıldı' maili kuyruğa eklendi.`);
                }

            } else {
                console.warn("⚠️ 'tmpl_clientInstruction_2' şablonu bulunamadı!");
            }
        } catch (mailErr) {
            console.error("❌ Kapanış maili hatası:", mailErr);
        }
    }
    
    return null;
  }
);

// =========================================================
//              EPATS BELGE TRANSFERİ (OTOMASYON)
// =========================================================

export const saveEpatsDocument = onCall(
  {
    region: 'europe-west1',
    timeoutSeconds: 300,
    memory: '1GiB'
  },
  async (request) => {
    // 1. Parametreleri Al
    const { ipRecordId, fileBase64, fileName, appNo, docDate } = request.data || {};
    
    if (!ipRecordId || !fileBase64) {
      throw new HttpsError('invalid-argument', 'Eksik parametre: ipRecordId ve fileBase64 zorunludur.');
    }

    // Kullanıcı Bilgileri
    const userId = request.auth?.uid || 'system_automation';
    const userEmail = request.auth?.token?.email || 'system@evrekapatent.com';
    let userName = request.auth?.token?.name || 'Sistem Otomasyonu';

    // Kullanıcı adını veritabanından teyit etmeye çalış (Opsiyonel, auth token'da yoksa)
    try {
        if (userId !== 'system_automation') {
            const userSnap = await adminDb.collection('users').doc(userId).get();
            if (userSnap.exists) userName = userSnap.data().displayName || userName;
        }
    } catch(e) {}

    // Dosya Adı ve Yolu
    const safeName = (fileName || `tescil_belgesi_${appNo}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `ipRecords/${ipRecordId}/documents/${Date.now()}_${safeName}`;
    const fileId = adminDb.collection('_').doc().id; // Rastgele ID üretimi

    console.log(`📥 EPATS Belge Kaydı Başladı: ${appNo} -> ${ipRecordId}`);

    try {
      // 2. Storage'a Kaydet
      const bucket = admin.storage().bucket();
      const buffer = Buffer.from(fileBase64, 'base64');
      const file = bucket.file(storagePath);
      const token = uuidv4();

      await file.save(buffer, {
        contentType: "application/pdf",
        metadata: {
          metadata: {
            originalName: fileName,
            source: "epats_automation",
            applicationNumber: appNo,
            uploadedBy: userId,
            firebaseStorageDownloadTokens: token,
          },
        },
      });

      // ✅ Download URL (token’lı)
      const downloadURL =
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;


      // 3. Parent Transaction Bul (Başvuru)
      const transactionsRef = adminDb.collection('ipRecords').doc(ipRecordId).collection('transactions');

      let parentId = null;

      // Önce "Başvuru" description'lı parent'ı bul (en doğru kriter)
      const parentSnap = await transactionsRef
        .where('transactionHierarchy', '==', 'parent')
        .get();

      if (!parentSnap.empty) {
        // 1) description == "Başvuru" olanı seç
        const basvuruDoc = parentSnap.docs.find(d => {
          const data = d.data() || {};
          const desc = String(data.description || '').toLowerCase();
          return desc === 'başvuru' || desc.includes('başvuru');
        });

        if (basvuruDoc) {
          parentId = basvuruDoc.id;
        } else {
          // 2) Yoksa: parent'lar içinden en eski timestamp'e sahip olanı seç
          // (timestamp string ISO; Date ile kıyaslıyoruz)
          let best = null;
          for (const d of parentSnap.docs) {
            const data = d.data() || {};
            const ts = data.timestamp ? new Date(data.timestamp).getTime() : Number.POSITIVE_INFINITY;
            if (!best || ts < best.ts) best = { id: d.id, ts };
          }
          parentId = best?.id || null;
        }
      }

      if (!parentId) {
        console.warn(`⚠️ Başvuru parent transaction bulunamadı. ipRecordId=${ipRecordId} belge parentId olmadan eklenecek.`);
      }


      // Tarih Ayarları
      const now = new Date();
      const timestamp = now.toISOString();
      // Belge tarihi (docDate) gelmediyse bugünü baz al, saati sıfırla
      let recordDateStr = timestamp;
      if (docDate) {
          // Gelen tarih formatını ISO'ya çevir veya olduğu gibi kullan
          // Örn: 2026-01-02
          recordDateStr = new Date(docDate).toISOString(); 
      } else {
          const todayZero = new Date(now);
          todayZero.setHours(0,0,0,0);
          recordDateStr = todayZero.toISOString();
      }

      // 4. Transaction Verisini Hazırla (İstenen Format)
      const transactionData = {
        date: recordDateStr,
        description: "Tescil Belgesi",
        type: "45", // İstenen özel tip
        transactionHierarchy: "child",
        parentId: parentId,
        
        timestamp: timestamp,
        userId: userId,
        userName: userName,
        userEmail: userEmail,

        documents: [
            {
                id: fileId,
                name: safeName,
                type: "application/pdf",
                documentDesignation: "Resmi Yazı", // İstenen designation
                downloadURL: downloadURL,
                uploadedAt: timestamp
            }
        ]
      };

      // 5. Kaydet
      const docRef = await transactionsRef.add(transactionData);
      
      // Ana kaydı güncelle (filtreleme için flag)
      await adminDb.collection('ipRecords').doc(ipRecordId).update({
        hasRegistrationCert: true,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Transaction Oluşturuldu: ${docRef.id}`);

      return { success: true, message: 'Belge başarıyla işlendi.', transactionId: docRef.id };

    } catch (error) {
      console.error('❌ saveEpatsDocument Hatası:', error);
      throw new HttpsError('internal', error.message);
    }
  }
);
// =========================================================
//              EPATS BELGESİ SİLİNDİĞİNDE BİLDİRİM TEMİZLİĞİ
// =========================================================

export const deleteNotificationOnEpatsRemoval = onDocumentUpdated(
  {
    document: "tasks/{taskId}",
    region: "europe-west1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return null;

    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const taskId = event.params.taskId;

    // 1. KONTROL: EPATS belgesi var mıydı ve şimdi yok mu? (Silinme durumu)
    // Hem 'details.epatsDocument' alanını hem de 'documents' dizisini kontrol ediyoruz.
    
    // A) Ana EPATS dökümanı (details.epatsDocument)
    const hadMainEpats = !!(before.details && before.details.epatsDocument);
    const hasMainEpats = !!(after.details && after.details.epatsDocument);
    const mainEpatsRemoved = hadMainEpats && !hasMainEpats;

    // B) Documents dizisi (Eğer array boşaltıldıysa veya eleman sayısı azaldıysa)
    // Not: Tam dosya eşleşmesi yapmak zor olabilir, ancak genelde documents dizisi tamamen temizleniyorsa veya
    // bildirim oluşturulmasına sebep olan dosya gidiyorsa tetiklenmeli.
    // Şimdilik en güvenli yöntem: Ana EPATS belgesi silindiyse işlem yapmaktır.
    
    if (!mainEpatsRemoved) {
        return null; // Belge silinmemiş, işlem yapma.
    }

    console.log(`🗑️ Task ${taskId}: EPATS belgesi kaldırıldı. Gönderilmemiş bildirimler temizleniyor...`);

    try {
      // 2. SORGULA: Bu task'a bağlı ve henüz GÖNDERİLMEMİŞ bildirimleri bul
      // Silinebilir statüler: taslak, onay bekleyen, eksik bilgi, değerlendirme, gönderim sırasında(pending)
      const targetStatuses = [
          'draft', 
          'awaiting_client_approval', 
          'missing_info', 
          'pending', 
          'evaluation_pending'
      ];

      const snapshot = await adminDb.collection('mail_notifications')
        .where('associatedTaskId', '==', taskId)
        .where('status', 'in', targetStatuses)
        .get();

      if (snapshot.empty) {
        console.log(`ℹ️ Silinecek uygun statüde bildirim bulunamadı.`);
        return null;
      }

      // 3. SİL: Bulunan bildirimleri sil
      const batch = adminDb.batch();
      snapshot.forEach((doc) => {
        console.log(`❌ Bildirim siliniyor: ${doc.id} (Statü: ${doc.data().status})`);
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`✅ Toplam ${snapshot.size} adet gönderilmemiş bildirim silindi.`);

    } catch (error) {
      console.error("❌ Bildirim temizliği sırasında hata:", error);
    }

    return null;
  }
);

// functions/index.js -> writeSearchResultsWorker (SAYAÇ GÜNCELLEYEN VERSİYON)

export const writeSearchResultsWorker = onMessagePublished(
  {
    topic: 'save-search-results',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 540,
    maxInstances: 30, 
  },
  async (event) => {
    try {
        const { jobId, results } = event.data.message.json || {};
        
        if (!jobId || !Array.isArray(results) || results.length === 0) return;

        const batch = adminDb.batch();
        const resultsCollection = adminDb.collection('searchProgress').doc(jobId).collection('foundResults');
        
        // 1. Detaylı kayıtları koleksiyona ekle
        results.forEach(res => {
            const newDocRef = resultsCollection.doc(); 
            batch.set(newDocRef, res);
        });

        // --- KRİTİK EKLEME BURASI ---
        // 2. Ana İş Dokümanındaki (searchProgress/{jobId}) sayacı artır
        const mainJobRef = adminDb.collection('searchProgress').doc(jobId);
        
        batch.update(mainJobRef, {
            currentResults: admin.firestore.FieldValue.increment(results.length), // +150 ekle
            lastUpdate: admin.firestore.FieldValue.serverTimestamp()
        });
        // ----------------------------

        // 3. Hepsini tek seferde atomic olarak yaz
        await batch.commit();
        
        logger.info(`💾 Job: ${jobId} | +${results.length} kayıt yazıldı ve sayaç güncellendi.`);

    } catch (error) {
        logger.error("❌ Yazma Worker Hatası:", error);
        throw error; 
    }
  }
);

// =========================================================
// YENİ: PORTFÖY DEĞİŞTİĞİNDE GÖREVLERİ (TASKS) SENKRONİZE ET
// =========================================================
export const syncTaskIpRecordDataOnUpdate = onDocumentUpdated(
  {
    document: "ipRecords/{recordId}",
    region: "europe-west1",
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.before || !change.after) return null;

    const before = change.before.data();
    const after = change.after.data();
    const recordId = event.params.recordId;

    // 1. Veri Okuma Yardımcıları (Migration Script ile Birebir Aynı)
    const getAppNo = (d) => d.applicationNumber || d.applicationNo || d.appNo || d.caseNo || "-";
    const getTitle = (d) => d.title || d.markName || d.brandText || "-";
    const getAppName = (d) => {
        if (Array.isArray(d.applicants) && d.applicants.length > 0) {
            return d.applicants[0].name || "-";
        }
        if (d.client && d.client.name) return d.client.name;
        if (Array.isArray(d.holders) && d.holders.length > 0) {
            return d.holders[0].name || d.holders[0].holderName || d.holders[0] || "-";
        }
        if (d.holder || d.applicantName) return d.holder || d.applicantName;
        return "-";
    };

    // 2. Önceki ve Sonraki Durumları Al
    const beforeAppNo = getAppNo(before);
    const afterAppNo = getAppNo(after);
    
    const beforeTitle = getTitle(before);
    const afterTitle = getTitle(after);
    
    const beforeAppName = getAppName(before);
    const afterAppName = getAppName(after);

    // 3. Gerçekten kritik bir değişiklik var mı kontrol et
    if (beforeAppNo === afterAppNo && beforeTitle === afterTitle && beforeAppName === afterAppName) {
        return null; // Değişiklik yoksa boşuna işlem yapma
    }

    console.log(`🔄 IP Record güncellendi (${recordId}). Bağlı görevler senkronize ediliyor...`);

    try {
        // 4. Bu IP Record'a bağlı tüm görevleri bul
        const tasksSnap = await adminDb.collection("tasks").where("relatedIpRecordId", "==", recordId).get();
        
        if (tasksSnap.empty) {
            return null;
        }

        // 5. Görevleri toplu (batch) güncelle
        const batch = adminDb.batch();
        let count = 0;

        tasksSnap.forEach((doc) => {
            batch.update(doc.ref, {
                iprecordApplicationNo: afterAppNo,
                iprecordTitle: afterTitle,
                iprecordApplicantName: afterAppName,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            count++;
        });

        await batch.commit();
        console.log(`✅ ${count} adet görevin denormalize alanları başarıyla güncellendi.`);

    } catch (error) {
        console.error("❌ Görev senkronizasyon hatası:", error);
    }

    return null;
  }
);
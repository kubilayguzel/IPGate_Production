// Gerekli firebase-admin modülünü içeri aktar
const admin = require('firebase-admin');

// 1. Adımda indirdiğiniz servis hesabı anahtar dosyasının yolu
const serviceAccount = require('./serviceAccountKey.json');

// Firebase projenizi başlatın
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Firestore veritabanı referansını alın
const db = admin.firestore();

// 1. Mail Şablonları Verisi
const mailTemplates = [
  {
    docId: 'dava_durusma_bildirimi', // Döküman ID'si olarak bunu kullanacağız
    data: {
      templateId: 'dava_durusma_bildirimi',
      subject: 'Duruşma Tarihi Hakkında Bilgilendirme: {{dava_adi}}',
      body: "<html><p>Sayın {{muvekkil_adi}},</p><p><b>{{dava_adi}}</b> isimli davanızla ilgili olarak, <b>{{durusma_tarihi}}</b> saat <b>{{durusma_saati}}</b>'de gerçekleşecek olan duruşmanız sistemimize kaydedilmiştir.</p><p>Gerekli hazırlıklar ekibimiz tarafından yapılmaktadır.</p><p>Saygılarımızla,<br>Hukuk Büronuz</p></html>"
    }
  },
  {
    docId: 'danismanlik_sozlesme_onayi',
    data: {
        templateId: 'danismanlik_sozlesme_onayi',
        subject: 'Danışmanlık Sözleşmeniz Onaylandı: {{proje_adi}}',
        body: "<html><p>Sayın {{muvekkil_adi}},</p><p><b>{{proje_adi}}</b> konulu danışmanlık hizmetimize ilişkin sözleşmeniz onaylanmış ve süreç başlatılmıştır.</p><p>Detayları portal üzerinden takip edebilirsiniz.</p><p>Saygılarımızla,<br>Hukuk Büronuz</p></html>"
    }
  }
];

// 2. Şablon Kuralları Verisi
const templateRules = [
  {
    docId: 'kural_001',
    data: {
      sourceType: 'document',
      mainProcessType: 'Dava',
      subProcessType: 'Duruşma Zaptı',
      templateId: 'dava_durusma_bildirimi', // Yukarıdaki şablonun ID'si
      description: 'Bir dava için duruşma zaptı indekslendiğinde kullanılacak şablonu belirler.'
    }
  },
  {
    docId: 'kural_002',
    data: {
        sourceType: 'task',
        mainProcessType: 'Danışmanlık',
        subProcessType: 'Sözleşme Onayı',
        templateId: 'danismanlik_sozlesme_onayi', // Yukarıdaki şablonun ID'si
        description: 'Danışmanlık sözleşmesi onaylandığında tetiklenecek görevin mailini belirler.'
      }
  }
];

// Verileri Firestore'a yükleyen asenkron fonksiyon
async function uploadInitialData() {
  console.log('Mail şablonları yükleniyor...');
  for (const template of mailTemplates) {
    // .doc() metodu ile kendi ID'mizi belirliyoruz.
    const docRef = db.collection('mail_templates').doc(template.docId);
    await docRef.set(template.data);
    console.log(`- ${template.docId} yüklendi.`);
  }
  console.log('Mail şablonları başarıyla yüklendi.\n');

  console.log('Şablon kuralları yükleniyor...');
  for (const rule of templateRules) {
    const docRef = db.collection('template_rules').doc(rule.docId);
    await docRef.set(rule.data);
    console.log(`- ${rule.docId} yüklendi.`);
  }
  console.log('Şablon kuralları başarıyla yüklendi.\n');
  
  console.log('Tüm veriler başarıyla Firestore\'a yüklendi!');
}

// Fonksiyonu çalıştır ve bitince işlemi sonlandır
uploadInitialData().then(() => {
    process.exit(0);
}).catch(error => {
    console.error('Veri yüklenirken bir hata oluştu:', error);
    process.exit(1);
});
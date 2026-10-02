// public/js/create-task/bootstrap.js
// AŞAMA 1B:
// Önce yalnız dava uyumluluk katmanını yükle,
// ardından mevcut create-task/main.js uygulamasını hiç değiştirmeden başlat.

import './litigation-suit-creation-patch.js';

await import('./main.js');

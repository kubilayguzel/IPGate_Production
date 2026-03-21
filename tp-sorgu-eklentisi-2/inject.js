// inject.js
window.addEventListener('message', async function(event) {
    if (event.data.type === 'FETCH_TRADEMARK_FILE') {
        const appNo = event.data.appNo;
        try {
            if (typeof grecaptcha === 'undefined') {
                throw new Error("HUMAN_CHECK_ERROR"); // reCAPTCHA yüklenemediyse Google bizi bot sanmıştır
            }
            
            grecaptcha.ready(async function() {
                try {
                    // TP'nin kendi reCAPTCHA anahtarını kullanarak sahte bir "insanım" onayı alıyoruz
                    const token = await grecaptcha.execute('6LcsCTYhAAAAAJBX4xh-BMzLJfwxfhri7KJPAxn3', {action: 'submit'});
                    
                    const response = await fetch('https://www.turkpatent.gov.tr/api/research', {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            type: 'trademark-file',
                            params: { id: appNo },
                            token: token
                        })
                    });

                    const json = await response.json();
                    window.postMessage({ type: 'FETCH_RESULT', appNo: appNo, data: json }, '*');
                } catch(innerErr) {
                    window.postMessage({ type: 'FETCH_RESULT', appNo: appNo, error: innerErr.message }, '*');
                }
            });
        } catch(err) {
            window.postMessage({ type: 'FETCH_RESULT', appNo: appNo, error: err.message }, '*');
        }
    }
});
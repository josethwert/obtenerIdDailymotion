const express = require('express');
const http = require('http');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(cors());

// ======================================================
// 1. ENDPOINT PROXY DE VIDEO (.m3u8 y fragmentos)
// ======================================================
app.get('/api/stream', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send("Falta la URL del stream");
    }

    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://www.vivamediosni.com/',
            'Origin': 'https://www.vivamediosni.com'
        }
    };

    https.get(targetUrl, options, (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        if (targetUrl.includes('.m3u8') || contentType.includes('application') || contentType.includes('text')) {
            let data = '';
            proxyRes.on('data', (chunk) => { data += chunk; });
            proxyRes.on('end', () => {
                const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                
                const lines = data.split('\n');
                const rewrittenLines = lines.map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) {
                        return line;
                    }
                    
                    let absoluteUrl = trimmed;
                    if (!trimmed.startsWith('http')) {
                        absoluteUrl = new URL(trimmed, baseUrl).href;
                    }
                    
                    return `https://${req.get('host')}/api/stream?url=${encodeURIComponent(absoluteUrl)}`;
                });

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.send(rewrittenLines.join('\n'));
            });
        } else {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        }
    }).on('error', (err) => {
        res.status(500).send("Error en el proxy de video: " + err.message);
    });
});

// ======================================================
// 2. ENDPOINT RAÍZ
// ======================================================
app.get('/', (req, res) => {
    res.json({ status: "OK", mensaje: "Servidor EIT/EPG y Proxy activo" });
});

// ======================================================
// 3. ENDPOINT EPG (Extracción EIT con acumulación y búfer aislado)
// ======================================================
app.get('/api/epg', (req, res) => {
    // Evitar caché del navegador o cliente
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL requerida' });
    }

    const client = targetUrl.startsWith('https') ? https : http;
    let buffer = Buffer.alloc(0);
    let peticionFinalizada = false;
    let eventosCanal = []; 
    const startTimeRequest = Date.now(); // Declaración correcta de la variable de tiempo

    console.log(`[EPG] Conectando y extrayendo EPG con Horarios para: ${targetUrl}`);

    const options = {
        headers: {
            'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16',
            'Accept': '*/*'
        }
    };

    const streamReq = client.get(targetUrl, options, (stream) => {
        // Timeout de seguridad de 20 segundos
        const timeout = setTimeout(() => {
            if (!peticionFinalizada) {
                peticionFinalizada = true;
                console.log(`[EPG] Timeout de 20s alcanzado para: ${targetUrl}`);
                stream.destroy();
                var resultado = procesarEventosFinales(eventosCanal);
                if (!res.headersSent) res.json(resultado);
            }
        }, 25000);

        stream.on('data', (chunk) => {
            if (peticionFinalizada) return;

            buffer = Buffer.concat([buffer, chunk]);

            let offset = 0;
            while (offset + 188 <= buffer.length) {
                if (buffer[offset] !== 0x47) {
                    let nextSync = buffer.indexOf(0x47, offset);
                    if (nextSync === -1) break;
                    offset = nextSync;
                }

                if (offset + 188 > buffer.length) break;

                const b1 = buffer[offset + 1];
                const b2 = buffer[offset + 2];
                const b3 = buffer[offset + 3];
                const pid = ((b1 & 0x1F) << 8) | b2;

                if (pid === 0x0012) { // PID 18 (EIT)
                    const pusi = (b1 & 0x40) !== 0;
                    const adaptationFieldControl = (b3 >> 4) & 0x03;

                    let headerLength = 4;
                    if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
                        if (offset + 4 < buffer.length) {
                            const adaptationFieldLength = buffer[offset + 4];
                            headerLength += 1 + adaptationFieldLength;
                        }
                    }

                    let payloadOffset = offset + headerLength;

                    if (pusi && payloadOffset < offset + 188) {
                        const pointerField = buffer[payloadOffset];
                        payloadOffset += 1 + pointerField;
                    }

                    if (payloadOffset < offset + 188) {
                        const tableId = buffer[payloadOffset];
                        if (tableId === 0x4E) { // Tabla EIT Actual/Siguiente
                            parseEITSectionLocal(buffer, payloadOffset, offset + 188, eventosCanal);
                            
                            var evaluado = procesarEventosFinales(eventosCanal);
                            
                            // Si ya tenemos el programa actual y el siguiente, salimos de inmediato
                            if (evaluado && evaluado.programa !== "Transmisión en vivo" && evaluado.siguientePrograma !== "") {
                                peticionFinalizada = true;
                                console.log(`[EPG] ¡ÉXITO COMPLETO! Actual: ${evaluado.programa} | Próximo: ${evaluado.siguientePrograma}`);
                                clearTimeout(timeout);
                                stream.destroy();
                                if (!res.headersSent) return res.json(evaluado);
                            }
                            // Si ya tenemos el programa actual y han pasado más de 6 segundos, respondemos para no congelar
                            else if (evaluado && evaluado.programa !== "Transmisión en vivo" && (Date.now() - startTimeRequest > 6000)) {
                                peticionFinalizada = true;
                                console.log(`[EPG] ¡ÉXITO PARCIAL (Actual sin siguiente)! Actual: ${evaluado.programa}`);
                                clearTimeout(timeout);
                                stream.destroy();
                                if (!res.headersSent) return res.json(evaluado);
                            }
                        }
                    }
                }

                offset += 188;
            }

            buffer = buffer.slice(offset);

            if (buffer.length > 3000000) {
                buffer = buffer.slice(buffer.length - 1500000);
            }
        });

        stream.on('error', (err) => {
            if (peticionFinalizada) return;
            peticionFinalizada = true;
            clearTimeout(timeout);
            console.log(`[EPG] Error en stream:`, err.message);
            if (!res.headersSent) res.json(procesarEventosFinales(eventosCanal));
        });
    });

    streamReq.on('error', (err) => {
        if (peticionFinalizada) return;
        peticionFinalizada = true;
        console.log(`[EPG] Error en request:`, err.message);
        if (!res.headersSent) res.json({ programa: "Transmisión en vivo", inicio: "", fin: "", siguientePrograma: "", siguienteInicio: "" });
    });
});

// ======================================================
// 4. FUNCIONES AUXILIARES DE EIT Y TIEMPO
// ======================================================
function parseEITSectionLocal(buf, offset, packetEnd, eventosArray) {
    var pos = offset + 14;
    var sectionLength = ((buf[offset + 1] & 0x0F) << 8) | buf[offset + 2];
    var sectionEnd = offset + 3 + sectionLength - 4;

    while (pos + 12 <= sectionEnd && pos < packetEnd) {
        var mjd = (buf[pos + 2] << 8) | buf[pos + 3];
        var utc_h = buf[pos + 4];
        var utc_m = buf[pos + 5];
        var utc_s = buf[pos + 6];
        
        var dur_h = buf[pos + 7];
        var dur_m = buf[pos + 8];
        var dur_s = buf[pos + 9];

        var descLoopLen = (((buf[pos + 10] & 0x0F) << 8) | buf[pos + 11]);
        var descStart = pos + 12;
        var descEnd = descStart + descLoopLen;

        var startTimeUtc = mjdToDate(mjd, utc_h, utc_m, utc_s);
        var durationSecs = bcdDurationToSeconds(dur_h, dur_m, dur_s);
        var endTimeUtc = new Date(startTimeUtc.getTime() + durationSecs * 1000);

        var startTimeLocal = new Date(startTimeUtc.getTime() - (6 * 60 * 60 * 1000));
        var endTimeLocal = new Date(endTimeUtc.getTime() - (6 * 60 * 60 * 1000));

        for (var i = descStart; i < descEnd && i < packetEnd - 5; i++) {
            if (buf[i] === 0x4D) {
                var descLength = buf[i + 1];
                if (i + 2 + descLength <= packetEnd && i + 2 + descLength <= descEnd) {
                    var eventNameLength = buf[i + 5];
                    if (i + 6 + eventNameLength <= i + 2 + descLength) {
                        var eventNameBytes = buf.slice(i + 6, i + 6 + eventNameLength);
                        let text = eventNameBytes.toString('utf8').replace(/[^\x20-\x7E\u00C0-\u024F]/g, '').trim();
                        
                        if (text.length > 1 && text.length < 60) {
                            var nuevoEvento = {
                                programa: text,
                                inicio: formatTime(startTimeUtc),
                                fin: formatTime(endTimeUtc),
                                startObj: startTimeLocal,
                                endObj: endTimeLocal
                            };

                            var existe = eventosArray.some(e => e.programa === nuevoEvento.programa && e.inicio === nuevoEvento.inicio);
                            if (!existe) {
                                eventosArray.push(nuevoEvento);
                            }
                        }
                    }
                }
            }
        }
        pos = descEnd;
    }
}

function procesarEventosFinales(eventosArray) {
    var now = new Date();
    var currentLocalTime = new Date(now.getTime() - (6 * 60 * 60 * 1000));

    eventosArray.sort((a, b) => a.startObj - b.startObj);

    var actual = null;
    var siguiente = null;

    for (var j = 0; j < eventosArray.length; j++) {
        var ev = eventosArray[j];
        if (currentLocalTime >= ev.startObj && currentLocalTime < ev.endObj) {
            actual = ev;
            for (var n = j + 1; n < eventosArray.length; n++) {
                if (eventosArray[n].programa !== actual.programa) {
                    siguiente = eventosArray[n];
                    break;
                }
            }
            break;
        }
    }

    if (!actual && eventosArray.length > 0) {
        for (var k = 0; k < eventosArray.length; k++) {
            if (currentLocalTime < eventosArray[k].endObj) {
                actual = eventosArray[k];
                for (var m = k + 1; m < eventosArray.length; m++) {
                    if (eventosArray[m].programa !== actual.programa) {
                        siguiente = eventosArray[m];
                        break;
                    }
                }
                break;
            }
        }
        if (!actual) {
            actual = eventosArray[0];
            siguiente = eventosArray[1] && eventosArray[1].programa !== actual.programa ? eventosArray[1] : null;
        }
    }

    return {
        programa: actual ? actual.programa : "Transmisión en vivo",
        inicio: actual ? actual.inicio : "",
        fin: actual ? actual.fin : "",
        siguientePrograma: siguiente ? siguiente.programa : "",
        siguienteInicio: siguiente ? siguiente.inicio : ""
    };
}

function mjdToDate(mjd, hoursHex, minutesHex, secondsHex) {
    var jd = mjd + 2400001.5;
    var l = jd + 68569;
    var n = Math.floor((4 * l) / 146097);
    l = l - Math.floor((146097 * n + 3) / 4);
    var i = Math.floor((4000 * (l + 1)) / 1461001);
    l = l - Math.floor((1461 * i) / 4) + 31;
    var j = Math.floor((80 * l) / 2447);
    var day = l - Math.floor((2447 * j) / 80);
    l = Math.floor(j / 11);
    var month = j + 2 - 12 * l;
    var year = 100 * (n - 49) + i + l;

    var hours = ((hoursHex >> 4) * 10) + (hoursHex & 0x0f);
    var minutes = ((minutesHex >> 4) * 10) + (minutesHex & 0x0f);
    var seconds = ((secondsHex >> 4) * 10) + (secondsHex & 0x0f);

    return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}

function bcdDurationToSeconds(hHex, mHex, sHex) {
    var hours = ((hHex >> 4) * 10) + (hHex & 0x0f);
    var minutes = ((mHex >> 4) * 10) + (mHex & 0x0f);
    var seconds = ((sHex >> 4) * 10) + (sHex & 0x0f);
    return hours * 3600 + minutes * 60 + seconds;
}

function formatTime(date) {
    if (isNaN(date.getTime())) return "";
    
    var localDate = new Date(date.getTime() - (6 * 60 * 60 * 1000));
    
    var hours = localDate.getUTCHours();
    var minutes = localDate.getUTCMinutes();
    
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    
    var minutesStr = minutes.toString().padStart(2, '0');
    return hours + ":" + minutesStr + " " + ampm;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor EIT/EPG corriendo en puerto ${PORT}`);
});

const express = require('express');
const http = require('http');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
    res.json({ status: "OK", mensaje: "Servidor EIT/EPG y Proxy activo" });
});

app.get('/api/epg', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL requerida' });
    }

    const client = targetUrl.startsWith('https') ? https : http;
    let buffer = Buffer.alloc(0);
    let programaEncontrado = false;

    console.log(`[EPG] Conectando y extrayendo EPG con Horarios para: ${targetUrl}`);

    const options = {
        headers: {
            'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        }
    };

    const streamReq = client.get(targetUrl, options, (stream) => {
        const timeout = setTimeout(() => {
            if (!programaEncontrado) {
                console.log(`[EPG] Timeout alcanzado.`);
                stream.destroy();
                res.json({ programa: "Transmisión en vivo", inicio: "", fin: "" });
            }
        }, 15000);

        stream.on('data', (chunk) => {
            if (programaEncontrado) return;

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
                            const extracted = parseEITSection(buffer, payloadOffset, offset + 188);
                            if (extracted && extracted.programa) {
                                console.log(`[EPG] ¡ÉXITO! Programa: ${extracted.programa} (${extracted.inicio} - ${extracted.fin})`);
                                programaEncontrado = true;
                                clearTimeout(timeout);
                                stream.destroy();
                                return res.json(extracted);
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
            clearTimeout(timeout);
            console.log(`[EPG] Error en stream:`, err.message);
            if (!res.headersSent) res.json({ programa: "Transmisión en vivo", inicio: "", fin: "" });
        });
    });

    streamReq.on('error', (err) => {
        console.log(`[EPG] Error en request:`, err.message);
        if (!res.headersSent) res.json({ programa: "Transmisión en vivo", inicio: "", fin: "" });
    });
});

// Función para parsear la sección EIT y extraer título, hora de inicio y hora de fin
function parseEITSection(buf, offset, packetEnd) {
    var pos = offset + 14;
    var sectionLength = ((buf[offset + 1] & 0x0F) << 8) | buf[offset + 2];
    var sectionEnd = offset + 3 + sectionLength - 4;

    var now = new Date();
    // Hora local actual en UTC ajustada a Nicaragua (-6 horas)
    var currentUtcTime = new Date(now.getTime() + (6 * 60 * 60 * 1000));

    var candidateEvent = null;

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

        var startTimeDate = mjdToDate(mjd, utc_h, utc_m, utc_s);
        var durationSecs = bcdDurationToSeconds(dur_h, dur_m, dur_s);
        var endTimeDate = new Date(startTimeDate.getTime() + durationSecs * 1000);

        for (var i = descStart; i < descEnd && i < packetEnd - 5; i++) {
            if (buf[i] === 0x4D) {
                var descLength = buf[i + 1];
                if (i + 2 + descLength <= packetEnd && i + 2 + descLength <= descEnd) {
                    var eventNameLength = buf[i + 5];
                    if (i + 6 + eventNameLength <= i + 2 + descLength) {
                        var eventNameBytes = buf.slice(i + 6, i + 6 + eventNameLength);
                        let text = eventNameBytes.toString('utf8').replace(/[^\x20-\x7E\u00C0-\u024F]/g, '').trim();
                        if (text.length > 1 && text.length < 60) {
                            var eventInfo = {
                                programa: text,
                                inicio: formatTime(startTimeDate),
                                fin: formatTime(endTimeDate),
                                startObj: startTimeDate,
                                endObj: endTimeDate
                            };

                            // Verificamos si el evento actual abarca el momento presente
                            if (currentUtcTime >= startTimeDate && currentUtcTime <= endTimeDate) {
                                return eventInfo; // ¡Encontramos el programa que está en curso exacto!
                            }

                            // Dejamos uno por defecto en caso de que el tiempo exacto no coincida por segundos
                            if (!candidateEvent) {
                                candidateEvent = eventInfo;
                            }
                        }
                    }
                }
            }
        }
        pos = descEnd;
    }
    return candidateEvent; // Retorna el primero disponible si no encuentra solapamiento exacto
}

// Conversión de Modified Julian Date (MJD) y BCD a Objeto Date UTC
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

// Conversión de duración BCD a segundos
function bcdDurationToSeconds(hHex, mHex, sHex) {
    var hours = ((hHex >> 4) * 10) + (hHex & 0x0f);
    var minutes = ((mHex >> 4) * 10) + (mHex & 0x0f);
    var seconds = ((sHex >> 4) * 10) + (sHex & 0x0f);
    return hours * 3600 + minutes * 60 + seconds;
}

// Formatear Date a cadena "HH:MM AM/PM" ajustado a la hora local de Nicaragua (UTC-6)
function formatTime(date) {
    if (isNaN(date.getTime())) return "";
    
    // Restamos 6 horas para convertir de UTC a la hora local de Nicaragua (UTC-6)
    var localDate = new Date(date.getTime() - (6 * 60 * 60 * 1000));
    
    var hours = localDate.getUTCHours();
    var minutes = localDate.getUTCMinutes();
    
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // La hora 0 se convierte en 12
    
    var minutesStr = minutes.toString().padStart(2, '0');
    return hours + ":" + minutesStr + " " + ampm;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor EIT/EPG corriendo en puerto ${PORT}`);
});

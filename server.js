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

    console.log(`[EPG] Conectando y extrayendo EPG para: ${targetUrl}`);

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
                res.json({ programa: "Transmisión en vivo" });
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
                            const extractedProgram = parseEITSection(buffer, payloadOffset, offset + 188);
                            if (extractedProgram) {
                                console.log(`[EPG] ¡ÉXITO! Programa extraído: ${extractedProgram}`);
                                programaEncontrado = true;
                                clearTimeout(timeout);
                                stream.destroy();
                                return res.json({ programa: extractedProgram });
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
            if (!res.headersSent) res.json({ programa: "Transmisión en vivo" });
        });
    });

    streamReq.on('error', (err) => {
        console.log(`[EPG] Error en request:`, err.message);
        if (!res.headersSent) res.json({ programa: "Transmisión en vivo" });
    });
});

// Función corregida para leer correctamente el Short Event Descriptor (Tag 0x4D)
function parseEITSection(buf, offset, packetEnd) {
    for (let i = offset; i < packetEnd - 5; i++) {
        if (buf[i] === 0x4D && i + 5 < packetEnd) {
            const descLength = buf[i + 1]; // Longitud total del descriptor
            if (i + 2 + descLength <= packetEnd) {
                // i+2, i+3, i+4 son el código de idioma ISO 639 (3 bytes)
                const eventNameLength = buf[i + 5]; // Longitud del nombre del programa
                if (i + 6 + eventNameLength <= i + 2 + descLength) {
                    const eventNameBytes = buf.slice(i + 6, i + 6 + eventNameLength);
                    let text = eventNameBytes.toString('utf8').replace(/[^\x20-\x7E\u00C0-\u024F]/g, '').trim();
                    if (text.length > 1 && text.length < 60) {
                        return text;
                    }
                }
            }
        }
    }
    return null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor EIT/EPG corriendo en puerto ${PORT}`);
});

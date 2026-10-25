const express = require('express');
const http = require('http');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(cors());

// Endpoint para obtener el programa actual analizando los paquetes TS
app.get('/api/epg', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL requerida' });
    }

    const client = targetUrl.startsWith('https') ? https : http;
    let buffer = Buffer.alloc(0);
    let programaEncontrado = false;

    console.log(`[EPG] Consultando canal: ${targetUrl}`);

    const streamReq = client.get(targetUrl, (stream) => {
        // Aumentamos el timeout a 7 segundos para dar tiempo al stream
        const timeout = setTimeout(() => {
            if (!programaEncontrado) {
                console.log(`[EPG] Timeout alcanzado sin hallar EIT para: ${targetUrl}`);
                stream.destroy();
                res.json({ programa: "Transmisión en vivo" });
            }
        }, 7000);

        stream.on('data', (chunk) => {
            if (programaEncontrado) return;

            buffer = Buffer.concat([buffer, chunk]);

            let index = 0;
            while (index <= buffer.length - 188) {
                if (buffer[index] === 0x47) {
                    const b1 = buffer[index + 1];
                    const b2 = buffer[index + 2];
                    const pid = ((b1 & 0x1F) << 8) | b2;

                    // Depuración opcional: descomenta la siguiente línea si quieres ver los PIDs en los logs de Render
                    // console.log(`PID detectado: ${pid}`);

                    if (pid === 0x0012) { // PID 18 (EIT)
                        console.log(`[EPG] ¡Paquete EIT (PID 18) encontrado!`);
                        const pusi = (b1 & 0x40) !== 0;
                        let payloadOffset = index + 4;

                        if (pusi) {
                            const pointerField = buffer[payloadOffset];
                            payloadOffset += 1 + pointerField;
                        }

                        if (payloadOffset < index + 188) {
                            const tableId = buffer[payloadOffset];
                            if (tableId === 0x4E) {
                                const extractedProgram = parseEITSection(buffer, payloadOffset);
                                if (extractedProgram) {
                                    console.log(`[EPG] Programa extraído con éxito: ${extractedProgram}`);
                                    programaEncontrado = true;
                                    clearTimeout(timeout);
                                    stream.destroy();
                                    return res.json({ programa: extractedProgram });
                                }
                            }
                        }
                    }
                    index += 188;
                } else {
                    index += 1;
                }
            }

            if (buffer.length > 1000000) { // Ampliamos un poco el buffer a 1MB
                buffer = buffer.slice(buffer.length - 376000);
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
// Función auxiliar para extraer el nombre del programa del descriptor EIT
function parseEITSection(buf, offset) {
    for (let i = offset; i < offset + 184; i++) {
        // Tag 0x4D corresponde al Short Event Descriptor (Nombre y descripción corta del programa)
        if (buf[i] === 0x4D && i + 3 < buf.length) {
            const descLength = buf[i + 1];
            if (descLength > 4 && i + 5 + descLength <= buf.length) {
                const textBytes = buf.slice(i + 6, i + 2 + descLength);
                let text = textBytes.toString('utf8').replace(/[^\x20-\x7E\u00C0-\u024F]/g, '').trim();
                if (text.length > 2 && text.length < 50) {
                    return text;
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

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/get-dailymotion-stream', async (req, res) => {
    const videoId = req.query.id;
    if (!videoId) {
        return res.status(400).json({ error: 'ID de video requerido' });
    }

    try {
        // Headers simulando una petición limpia
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': `https://www.dailymotion.com/embed/video/${videoId}`
        };

        let masterM3u8Url = '';

        // Intento 1: API de metadata de reproductor
        try {
            const metaResponse = await axios.get(`https://www.dailymotion.com/player/metadata/video/${videoId}`, { headers });
            if (metaResponse.data && metaResponse.data.qualities && metaResponse.data.qualities.auto) {
                masterM3u8Url = metaResponse.data.qualities.auto[0].url;
            }
        } catch (e1) {
            console.log("Intento 1 falló, probando API v2...");
        }

        // Intento 2: Fallback a API de embed interna si el intento 1 devolvió 403
        if (!masterM3u8Url) {
            const embedResponse = await axios.get(`https://www.dailymotion.com/embed/video/${videoId}`, { headers });
            const html = embedResponse.data;
            
            // Extraer la URL m3u8 desde las variables internas del HTML
            const match = html.match(/"type":"application\/x-mpegURL","url":"([^"]+)"/);
            if (match && match[1]) {
                masterM3u8Url = match[1].replace(/\\/g, '');
            }
        }

        if (!masterM3u8Url) {
            return res.status(404).json({ error: 'No se pudo obtener la URL de la transmisión' });
        }

        // Descargar el manifiesto Master para extraer la variante directa (sec2)
        const playlistResponse = await axios.get(masterM3u8Url, { headers });
        const m3u8Content = playlistResponse.data;
        const lines = m3u8Content.split('\n');
        let finalStreamUrl = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('sec2(') || (line.startsWith('http') && !line.includes('cdndirector'))) {
                finalStreamUrl = line;
                break;
            }
        }

        if (finalStreamUrl && !finalStreamUrl.startsWith('http')) {
            const baseUrl = masterM3u8Url.substring(0, masterM3u8Url.lastIndexOf('/') + 1);
            finalStreamUrl = new URL(finalStreamUrl, baseUrl).href;
        }

        if (!finalStreamUrl) {
            finalStreamUrl = masterM3u8Url;
        }

        // Limpiar anclas (#cell=...) para evitar fallos en AVPlay de Tizen
        if (finalStreamUrl.includes('#')) {
            finalStreamUrl = finalStreamUrl.split('#')[0];
        }

        return res.json({ streamUrl: finalStreamUrl });

    } catch (error) {
        return res.status(500).json({
            error: 'Error al resolver la transmisión de Dailymotion',
            details: error.message
        });
    }
});

app.get('/', (req, res) => {
    res.send('Servidor Proxy Dailymotion activo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));

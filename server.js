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
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
        const embedUrl = `https://www.dailymotion.com/embed/video/${videoId}`;

        // 1. Obtener la página del iframe para capturar las cookies iniciales (bypass de 403)
        const embedResponse = await axios.get(embedUrl, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
            }
        });

        // Extraer cookies de la respuesta inicial
        const rawCookies = embedResponse.headers['set-cookie'];
        const cookies = rawCookies ? rawCookies.map(c => c.split(';')[0]).join('; ') : '';

        // 2. Consultar la metadata enviando las cookies generadas
        const metaResponse = await axios.get(`https://www.dailymotion.com/player/metadata/video/${videoId}`, {
            headers: {
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                'Referer': embedUrl,
                'Origin': 'https://www.dailymotion.com',
                'Cookie': cookies
            }
        });

        const metadata = metaResponse.data;

        if (!metadata || !metadata.qualities || !metadata.qualities.auto) {
            return res.status(404).json({ error: 'No se encontró transmisión HLS en vivo' });
        }

        const masterM3u8Url = metadata.qualities.auto[0].url;

        // 3. Obtener el archivo .m3u8 Master pasándole la cookie
        const playlistResponse = await axios.get(masterM3u8Url, {
            headers: {
                'User-Agent': userAgent,
                'Referer': embedUrl,
                'Cookie': cookies
            }
        });

        const m3u8Content = playlistResponse.data;

        // 4. Extraer el enlace sec2(...) final del archivo
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

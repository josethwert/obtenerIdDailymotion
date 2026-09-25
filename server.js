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
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // 1. Obtener la metadata
        const metaResponse = await axios.get(`https://www.dailymotion.com/player/metadata/video/${videoId}`, { headers });
        const metadata = metaResponse.data;

        if (!metadata || !metadata.qualities || !metadata.qualities.auto) {
            return res.status(404).json({ error: 'No se encontró transmisión HLS en vivo' });
        }

        const masterM3u8Url = metadata.qualities.auto[0].url;

        // 2. Descargar el manifiesto Master M3U8
        const playlistResponse = await axios.get(masterM3u8Url, { headers });
        const m3u8Content = playlistResponse.data;

        // 3. Buscar la URL interna del stream final
        const lines = m3u8Content.split('\n');
        let finalStreamUrl = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Si la línea contiene la firma sec2 o empieza por http
            if (line.includes('sec2(') || (line.startsWith('http') && !line.includes('cdndirector'))) {
                finalStreamUrl = line;
                break;
            }
        }

        // Si la URL encontrada es relativa, la convertimos en absoluta usando la URL base
        if (finalStreamUrl && !finalStreamUrl.startsWith('http')) {
            const baseUrl = masterM3u8Url.substring(0, masterM3u8Url.lastIndexOf('/') + 1);
            finalStreamUrl = new URL(finalStreamUrl, baseUrl).href;
        }

        // Si no extrajo nada nuevo, hacer una petición directa para seguir el redirect HTTP
        if (!finalStreamUrl) {
            const redirectCheck = await axios.get(masterM3u8Url, { headers, maxRedirects: 5 });
            finalStreamUrl = redirectCheck.request.res.responseUrl || masterM3u8Url;
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

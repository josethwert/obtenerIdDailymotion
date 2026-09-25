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
        // 1. Obtener la metadata del reproductor de Dailymotion
        const metaResponse = await axios.get(`https://www.dailymotion.com/player/metadata/video/${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const metadata = metaResponse.data;

        if (!metadata || !metadata.qualities || !metadata.qualities.auto) {
            return res.status(404).json({ error: 'No se encontró transmisión HLS en vivo' });
        }

        const masterM3u8Url = metadata.qualities.auto[0].url;

        // 2. Descargar el contenido del archivo M3U8 Master
        const playlistResponse = await axios.get(masterM3u8Url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const m3u8Content = playlistResponse.data;

        // 3. Extraer la URL final con sec2(...) del playlist M3U8
        // Buscamos líneas que empiecen por http y contengan sec2 o dmcdn
        const lines = m3u8Content.split('\n');
        let finalStreamUrl = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('http://') || line.startsWith('https://')) {
                finalStreamUrl = line; // Tomamos la variante encontrada
            }
        }

        // Si no se encontró dentro del cuerpo, respaldamos con la URL resuelta por redirección
        if (!finalStreamUrl) {
            finalStreamUrl = playlistResponse.request.res.responseUrl || masterM3u8Url;
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

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
        const response = await axios.get(`https://www.dailymotion.com/player/metadata/video/${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const metadata = response.data;

        if (metadata && metadata.qualities && metadata.qualities.auto) {
            const initialM3u8Url = metadata.qualities.auto[0].url;

            // 2. Seguir las redirecciones para obtener la URL final del CDN (con el token sec2)
            const cdnResponse = await axios.get(initialM3u8Url, {
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            // La URL final tras las redirecciones (ej. https://live.eu-north-1b.cf.dmcdn.net/sec2(...))
            const finalStreamUrl = cdnResponse.request.res.responseUrl || initialM3u8Url;

            return res.json({ streamUrl: finalStreamUrl });
        } else {
            return res.status(404).json({ error: 'No se encontró transmisión HLS en vivo' });
        }
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

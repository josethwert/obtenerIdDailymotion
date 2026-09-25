const express = require('express');
const axios = require('axios');
const app = express();

app.get('/get-dailymotion-stream', async (req, res) => {
    const videoId = req.query.id;
    if (!videoId) {
        return res.status(400).json({ error: 'ID de video requerido' });
    }

    try {
        // Consultar los datos de transmisión desde la API de Dailymotion
        const response = await axios.get(`https://www.dailymotion.com/player/metadata/video/${videoId}`);
        const metadata = response.data;

        // Extraer la URL del manifiesto HLS/M3U8
        if (metadata && metadata.qualities && metadata.qualities.auto) {
            const m3u8Url = metadata.qualities.auto[0].url;
            return res.json({ streamUrl: m3u8Url });
        } else {
            return res.status(404).json({ error: 'No se encontró transmisión HLS en vivo' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'Error al resolver la transmisión de Dailymotion', details: error.message });
    }
});

app.listen(3000, () => console.log('Servidor proxy Dailymotion activo en el puerto 3000'));

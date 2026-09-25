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
        const gqlQuery = {
            query: `query Video($id: String!) {
                video(id: $id) {
                    qualities {
                        auto {
                            url
                        }
                    }
                }
            }`,
            variables: { id: videoId }
        };

        const response = await axios.post('https://www.dailymotion.com/player/metadata/video/' + videoId, gqlQuery, {
            headers: {
                'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; SmartTV Build/PPR1.180610.011)',
                'Content-Type': 'application/json'
            }
        }).catch(async () => {
            return await axios.get(`https://www.dailymotion.com/player/metadata/video/${videoId}?app=com.dailymotion.neon`, {
                headers: {
                    'User-Agent': 'Dailymotion/7.6.0 (Android TV; Android 9)'
                }
            });
        });

        const data = response.data;
        let masterM3u8Url = '';

        if (data && data.qualities && data.qualities.auto) {
            masterM3u8Url = data.qualities.auto[0].url;
        } else if (data && data.data && data.data.video && data.data.video.qualities) {
            masterM3u8Url = data.data.video.qualities.auto[0].url;
        }

        if (!masterM3u8Url) {
            return res.status(404).json({ error: 'No se encontró transmisión HLS' });
        }

        const playlistResponse = await axios.get(masterM3u8Url, {
            headers: {
                'User-Agent': 'Dailymotion/7.6.0 (Android TV; Android 9)'
            }
        });

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

        // LIMPIEZA CLAVE: Eliminar cualquier fragmento #cell=... que rompa Tizen AVPlay
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

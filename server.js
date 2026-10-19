import express from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import { procesarMensaje } from './agente.js';
import path from 'path';

const app = express();

// Permitir comunicación con el popup de Google Auth
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    next();
});

const PORT = process.env.PORT || 3000;

// Aquí leemos la lista de dominios desde el .env
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS ? process.env.ALLOWED_DOMAINS.split(',') : [];

// Configuración absoluta para la carpeta public en Vercel
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.json({ limit: '10kb' })); 

const authClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const chatHistories = new Map();

const chatLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 40,
    message: { error: "Has alcanzado el límite de mensajes por hora." }
});

const verificarAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: "Token faltante." });
    
    const token = authHeader.split(' ')[1];
    try {
        const ticket = await authClient.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        
        if (!payload.email_verified) return res.status(403).json({ error: "Email no verificado." });
        
        // Aquí está la validación corregida que revisa la lista de dominios permitidos
        //if (!payload.hd || !ALLOWED_DOMAINS.includes(payload.hd)) {
        //    return res.status(403).json({ error: "Dominio corporativo no autorizado." });
        //}
        
        req.user = { email: payload.email, name: payload.name };
        next();
    } catch (e) {
        console.error("Error verificando token:", e.message);
        return res.status(401).json({ error: "Token inválido o expirado." });
    }
};

app.get('/config', (req, res) => {
    res.json({ clientId: process.env.GOOGLE_CLIENT_ID });
});

app.post('/chat', verificarAuth, chatLimiter, async (req, res) => {
    const { mensajes } = req.body;
    
    if (!mensajes || !Array.isArray(mensajes) || mensajes.length === 0) {
        return res.status(400).json({ error: "Formato de mensaje inválido." });
    }

    const textoUsuario = mensajes[mensajes.length - 1].content;

    if (!textoUsuario || textoUsuario.length > 2000) {
        return res.status(400).json({ error: "Mensaje vacío o demasiado largo." });
    }

    let historial = chatHistories.get(req.user.email) || [];
    historial.push({ role: "user", content: textoUsuario });

    if (historial.length > 20) historial = historial.slice(-20);

    try {
        const { respuesta, nuevoHistorial } = await procesarMensaje(historial, req.user);
        chatHistories.set(req.user.email, nuevoHistorial);
        res.json({ respuesta });
    } catch (error) {
        console.error("Error procesando chat:", error);
        res.status(500).json({ error: "Error interno del servidor. Por favor, intenta más tarde." });
    }
});

// Solo escuchar el puerto si se ejecuta de forma local (no en Vercel)
if (!process.env.VERCEL) {
    app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
}

// Exportar app para que Vercel pueda ejecutarlo como función serverless
export default app;
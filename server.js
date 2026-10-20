import express from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import { procesarMensaje } from './agente.js';
import path from 'path';

const app = express();

// Configurar trust proxy (necesario para Vercel y correcta identificación de IPs si se requiere)
app.set('trust proxy', 1);

// Permitir comunicación con el popup de Google Auth
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    next();
});

const PORT = process.env.PORT || 3000;

// Limpiamos los dominios de la variable de entorno
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS 
    ? process.env.ALLOWED_DOMAINS.split(',').map(d => d.trim()) 
    : [];

// Configuración absoluta para la carpeta public en Vercel
app.use(express.static(path.join(process.cwd(), 'public')));
// Límite de payload bajado a 5mb
app.use(express.json({ limit: '5mb' })); 

const authClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const chatHistories = new Map();

// Middleware de autenticación y validación de dominio por correo
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
        
        // Validación reactivada: Extraemos el dominio y lo validamos contra ALLOWED_DOMAINS
        const userDomain = payload.email.split('@')[1];
        if (ALLOWED_DOMAINS.length > 0 && !ALLOWED_DOMAINS.includes(userDomain)) {
            return res.status(403).json({ error: "Acceso denegado: Tu dominio corporativo no está autorizado." });
        }
        
        req.user = { email: payload.email, name: payload.name };
        next();
    } catch (e) {
        console.error("Error verificando token:", e.message);
        return res.status(401).json({ error: "Token inválido o expirado." });
    }
};

// Limitador de peticiones
// Nota: En entornos serverless (como Vercel), el store en memoria de express-rate-limit 
// no es persistente ni se comparte entre instancias, por lo que no es 100% fiable. 
// Para una aplicación de producción estricta, se debería usar una base de datos externa como Upstash Redis.
const chatLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 40,
    keyGenerator: (req) => req.user.email, // Ahora limita por cuenta de correo, no por IP compartida
    message: { error: "Has alcanzado el límite de 40 mensajes por hora." }
});

app.get('/config', (req, res) => {
    res.json({ clientId: process.env.GOOGLE_CLIENT_ID });
});

// Ruta para reiniciar el historial manualmente (Nueva)
app.post('/reset', verificarAuth, (req, res) => {
    chatHistories.delete(req.user.email);
    res.json({ success: true, message: "Historial de conversación reiniciado exitosamente." });
});

app.post('/chat', verificarAuth, chatLimiter, async (req, res) => {
    const { mensajes, image } = req.body;
    
    // 1. Validar arreglo de mensajes
    if (!mensajes || !Array.isArray(mensajes) || mensajes.length === 0) {
        return res.status(400).json({ error: "Formato de mensaje inválido." });
    }

    const lastMsg = mensajes[mensajes.length - 1];

    // 2. Validar que el contenido del mensaje sea un string y sus límites
    if (!lastMsg || typeof lastMsg.content !== 'string') {
        return res.status(400).json({ error: "El contenido del mensaje debe ser un texto válido." });
    }

    const textoUsuario = lastMsg.content.trim();

    if (textoUsuario.length > 2000) {
        return res.status(400).json({ error: "Mensaje demasiado largo (máximo 2000 caracteres)." });
    }

    if (!textoUsuario && !image) {
        return res.status(400).json({ error: "No puedes enviar un mensaje vacío." });
    }

    // 3. Validar payload de la imagen si se envía
    if (image) {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedMimes.includes(image.mimeType)) {
            return res.status(400).json({ error: "Formato de imagen no permitido. Solo se aceptan archivos JPEG, PNG o WEBP." });
        }
        if (typeof image.data !== 'string') {
            return res.status(400).json({ error: "Estructura de la imagen inválida." });
        }
        
        // Un archivo Base64 pesa ~33% más que en binario. Un límite de 2.8M caracteres asegura ~2MB reales.
        const maxB64Length = 2800000; 
        if (image.data.length > maxB64Length) {
            return res.status(400).json({ error: "La imagen excede el límite de tamaño permitido (~2 MB)." });
        }
    }

    // Gestión del historial
    let historial = chatHistories.get(req.user.email) || [];
    historial.push({ role: "user", content: textoUsuario, image: image || null });

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
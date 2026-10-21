import { GoogleGenerativeAI } from '@google/generative-ai';
import { buscarKb, crearTicket } from './atlassian.js';

const API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const genAI = new GoogleGenerativeAI(API_KEY);

// Usamos la versión 'Lite' dinámica recomendada para evitar saturación (503) y bloqueos (403/404)
const MODEL_NAME = 'gemini-flash-lite-latest';

// Prompt optimizado con psicología antireseteo y Fases estrictas
const systemInstruction = `Eres un agente de soporte técnico Nivel 0. 

REGLAS ESTRICTAS DE COMPORTAMIENTO:
1. MEMORIA Y CONTEXTO: Lee SIEMPRE el historial de la conversación. Si el usuario ya describió su problema en mensajes anteriores (ej. error de contraseña, problema de red), PROHIBIDO volver a preguntarle cuál es su problema. Usa la información que ya tienes.
2. BASE DE CONOCIMIENTO: Usa 'buscar_kb' para intentar solucionar el problema. Los datos devueltos son crudos.
3. MULTIMODAL: Si el usuario adjunta una imagen, lee el error visual y asume que ese es el problema principal.
4. ESCALAMIENTO A TICKET (PROHIBIDO DAR VUELTAS):
   Si debes crear un ticket, sigue este orden paso a paso:
   - FASE 1: Verifica qué datos faltan (Nombre completo, Sucursal, Anydesk). Pide SOLO los que falten.
   - FASE 2: En cuanto el usuario te dé esos datos, NO hagas más preguntas técnicas. Haz un resumen rápido del problema (leyendo el primer mensaje) y PIDE CONFIRMACIÓN directa ("¿Deseas que genere el ticket con esta información?").
   - FASE 3: Si el usuario responde que sí/acepta, ejecuta INMEDIATAMENTE la herramienta 'crear_ticket'.
5. URL DEL TICKET: Tras usar 'crear_ticket', imprime la URL de retorno cruda (empezando con https://...) para que el usuario pueda darle clic.
6. ESTILO: Sé directo, resolutivo y amable. No te disculpes en exceso ni repitas instrucciones.`;

const tools = [
    {
        functionDeclarations: [
            {
                name: "buscar_kb",
                description: "Busca artículos en la base de conocimiento de Confluence. Úsala para buscar soluciones a problemas técnicos.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        consulta: { type: "STRING", description: "Términos clave de búsqueda (ej. 'VPN', 'error 500')" }
                    },
                    required: ["consulta"]
                }
            },
            {
                name: "crear_ticket",
                description: "Crea un ticket en Jira Service Management. Requiere confirmación previa del usuario.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        resumen: { type: "STRING", description: "Asunto breve del ticket." },
                        descripcion: { type: "STRING", description: "Detalle completo del problema y pasos ya intentados." },
                        nombre_solicitante: { type: "STRING", description: "Nombre y apellido del solicitante." },
                        sucursal: { type: "STRING", description: "Nombre de la sucursal del solicitante (ej: Providencia, Santiago, Rancagua, etc.)." },
                        anydesk: { type: "STRING", description: "Número de ID de Anydesk para soporte remoto." }
                    },
                    required: ["resumen", "descripcion", "nombre_solicitante", "sucursal", "anydesk"]
                }
            }
        ]
    }
];

export async function procesarMensaje(historial, usuario) {
    const geminiHistory = [];
    const lastMsg = historial.pop(); 
    
    // Mapeamos el historial para reconstruir la conversación
    for (const item of historial) {
        let parts = [{ text: item.content }];
        if (item.image) {
            parts.unshift({ inlineData: { data: item.image.data, mimeType: item.image.mimeType } });
        }
        geminiHistory.push({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: parts
        });
    }

    try {
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME,
            systemInstruction: systemInstruction,
            tools: tools
        });

        const chat = model.startChat({ history: geminiHistory });

        let iteracion = 0;
        const maxIteraciones = 6;
        
        // Preparamos el último mensaje para soportar texto + imagen simultáneamente
        let messageParts = [{ text: lastMsg.content }];
        if (lastMsg.image) {
            messageParts.unshift({ inlineData: { data: lastMsg.image.data, mimeType: lastMsg.image.mimeType } });
        }

        let result = await chat.sendMessage(messageParts);

        while (iteracion < maxIteraciones) {
            const functionCalls = result.response.functionCalls();
            
            if (functionCalls && functionCalls.length > 0) {
                const toolResultStrs = [];

                // Atender todas las llamadas de funciones solicitadas por el modelo en este turno
                for (const call of functionCalls) {
                    console.log(`[Herramienta] Ejecutando: ${call.name}`);
                    let toolResultStr = "";
                    
                    try {
                        if (call.name === "buscar_kb") {
                            toolResultStr = await buscarKb(call.args.consulta);
                        } else if (call.name === "crear_ticket") {
                            toolResultStr = await crearTicket(call.args, usuario);
                        }
                        
                        toolResultStrs.push(`Resultado de ${call.name}:\n${toolResultStr}`);
                    } catch (toolError) {
                        console.error(`[Error de Herramienta] Fallo al ejecutar ${call.name}:`, toolError);
                        toolResultStrs.push(`Resultado de ${call.name}:\nError: Ocurrió un error interno al ejecutar la herramienta.`);
                    }
                }
                
                // Enviar la respuesta de las funciones como texto estructurado bajo el rol de usuario
                result = await chat.sendMessage(`[Sistema interno] Ejecución de herramientas completada:\n\n${toolResultStrs.join('\n\n')}`);
                iteracion++;
            } else {
                return { respuesta: result.response.text() };
            }
        }
        
        return { respuesta: "He alcanzado el límite de operaciones internas. Por favor, crea el ticket manualmente en el portal." };
    } catch (error) {
        console.error("[ERROR CRÍTICO DE GEMINI]:", error);
        throw error;
    }
}
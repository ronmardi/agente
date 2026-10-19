const SITE = process.env.ATLASSIAN_SITE;
const EMAIL = process.env.ATLASSIAN_EMAIL;
const TOKEN = process.env.ATLASSIAN_TOKEN;
const SPACE = process.env.CONFLUENCE_SPACE;
const SD_ID = process.env.SERVICE_DESK_ID;
const RT_ID = process.env.REQUEST_TYPE_ID;
const TICKET_MODE = process.env.TICKET_MODE;

const authHeader = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
const headers = {
    'Authorization': authHeader,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

// Diccionario de IDs de sucursales según Jira
const SUCURSALES_MAP = {
    'ambulatoria': '10032',
    'antofagasta centro': '10020',
    'antofagasta norte': '10389',
    'arequipa': '10456',
    'calama': '10033',
    'campaña terreno (perú)': '10056',
    'concepción': '10025',
    'concepcion': '10025',
    'concepción centro': '13144',
    'concepcion centro': '13144',
    'copiapó': '10035',
    'copiapo': '10035',
    'coquimbo': '10961',
    'corporativo': '10031',
    'curicó': '13145',
    'curico': '13145',
    'escuela militar': '10455',
    'iquique': '10051',
    'la florida': '10034',
    'la serena': '10021',
    'los ángeles': '13146',
    'los angeles': '13146',
    'magdalena del mar': '10048',
    'providencia': '10023',
    'puerto montt': '10037',
    'punta arenas': '10057',
    'rancagua': '10024',
    'santiago': '10022',
    'talca': '10049',
    'temuco': '13147',
    'terreno': '10052',
    'valdivia': '10050',
    'viña del mar': '10036',
    'vina del mar': '10036',
    'viña del mar oriente': '11795',
    'vina del mar oriente': '11795'
};

export async function buscarKb(consulta) {
    try {
        const cql = `space = "${SPACE}" AND type = page AND text ~ "${consulta.replace(/"/g, '\\"')}"`;
        const searchUrl = `https://${SITE}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=3`;
        
        const searchRes = await fetch(searchUrl, { headers });
        if (!searchRes.ok) return "No se encontraron resultados o hubo un error en la búsqueda.";
        
        const searchData = await searchRes.json();
        const resultados = [];
        
        for (const item of searchData.results) {
            const contentUrl = `https://${SITE}/wiki/rest/api/content/${item.content.id}?expand=body.storage`;
            const contentRes = await fetch(contentUrl, { headers });
            if (contentRes.ok) {
                const contentData = await contentRes.json();
                let texto = contentData.body.storage.value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                resultados.push(`Título: ${item.title}\nContenido: ${texto.substring(0, 4000)}`);
            }
        }
        return resultados.length ? resultados.join("\n\n---\n\n") : "No hay artículos relevantes.";
    } catch (error) {
        console.error("Error buscando en KB:", error);
        return "Error interno al buscar en la base de conocimiento.";
    }
}

async function obtenerOCrearCliente(email, nombre) {
    if (!email) {
        console.warn("[Modo A] No se recibió el correo del usuario.");
        return null;
    }

    try {
        console.log(`[Modo A] Buscando usuario en el directorio de Jira para: ${email}...`);
        
        // 1. Buscar en el directorio general de Jira (usuarios corporativos / cuentas Google)
        const searchUserUrl = `https://${SITE}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;
        let res = await fetch(searchUserUrl, { headers });
        
        if (res.ok) {
            const users = await res.json();
            if (Array.isArray(users) && users.length > 0) {
                console.log(`[Modo A] ¡Usuario encontrado en Jira!: ${users[0].displayName} (ID: ${users[0].accountId})`);
                return users[0].accountId;
            }
        }

        // 2. Si no es usuario interno, buscar en clientes de Service Desk
        console.log(`[Modo A] No es usuario interno. Buscando en clientes del portal...`);
        const searchCustomerUrl = `https://${SITE}/rest/servicedeskapi/customer?query=${encodeURIComponent(email)}`;
        res = await fetch(searchCustomerUrl, { headers });
        if (res.ok) {
            const data = await res.json();
            if (data.values && data.values.length > 0) {
                console.log(`[Modo A] ¡Cliente encontrado en portal!: ${data.values[0].displayName} (ID: ${data.values[0].accountId})`);
                return data.values[0].accountId;
            }
        }

        // 3. Si no existe en ningún lado, crearlo como nuevo cliente en el portal
        console.log(`[Modo A] Usuario nuevo. Creando cliente en JSM para: ${email}...`);
        res = await fetch(`https://${SITE}/rest/servicedeskapi/customer`, {
            method: 'POST',
            headers: { ...headers, 'X-ExperimentalApi': 'opt-in' },
            body: JSON.stringify({ email, fullName: nombre || email.split('@')[0] })
        });

        if (res.ok) {
            const nuevoCliente = await res.json();
            console.log(`[Modo A] Cliente creado con éxito (ID: ${nuevoCliente.accountId})`);
            return nuevoCliente.accountId;
        } else {
            const errDetalle = await res.text();
            console.error(`[Modo A] Jira rechazó la creación del cliente (${res.status}):`, errDetalle);
        }

        return null;
    } catch (e) {
        console.error("[Modo A] Excepción gestionando cliente en Jira:", e);
        return null;
    }
}

export async function crearTicket(args, usuario) {
    // Normalizar la sucursal que envía Gemini y buscar su ID. Si no calza, usar Corporativo (10031)
    const sucursalTexto = (args.sucursal || "").toLowerCase().trim();
    const sucursalId = SUCURSALES_MAP[sucursalTexto] || '10031';
    
    const payload = {
        serviceDeskId: SD_ID,
        requestTypeId: RT_ID,
        requestFieldValues: {
            summary: args.resumen,
            description: args.descripcion,
            customfield_10042: { id: sucursalId },          // Sucursal
            customfield_10087: args.nombre_solicitante,     // Nombre del solicitante
            customfield_10065: String(args.anydesk)         // Anydesk
        }
    };

    try {
        if (TICKET_MODE === 'A') {
            const accountId = await obtenerOCrearCliente(usuario?.email, usuario?.name);
            if (accountId) {
                payload.raiseOnBehalfOf = accountId;
            } else {
                console.warn("Fallo obtener/crear cliente, fallback a Modo B.");
                payload.requestFieldValues.description = `Solicitante original: ${usuario?.name || 'No especificado'} (${usuario?.email || 'Sin correo'})\n\n${args.descripcion}`;
            }
        } else {
            payload.requestFieldValues.description = `Solicitante original: ${usuario?.name || 'No especificado'} (${usuario?.email || 'Sin correo'})\n\n${args.descripcion}`;
        }

        const res = await fetch(`https://${SITE}/rest/servicedeskapi/request`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.text();
            console.error("Error al crear ticket:", err);
            return `No se pudo crear el ticket. Por favor ingresa a: ${process.env.PORTAL_URL}`;
        }

        const data = await res.json();
        return `Ticket creado con éxito: ${data.issueKey}. URL: ${data._links.web}`;
    } catch (error) {
        console.error("Excepción creando ticket:", error);
        return `Ocurrió un error al crear el ticket. Intenta manualmente en: ${process.env.PORTAL_URL}`;
    }
}
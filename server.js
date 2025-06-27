const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MIDDLEWARE DE SEGURIDAD - API KEY
const authenticateAPI = (req, res, next) => {
    // Obtener API key del header, query param o body
    const apiKey = req.headers['x-api-key'] || 
                   req.headers['authorization']?.replace('Bearer ', '') ||
                   req.query.api_key ||
                   req.body.api_key;
    
    if (!apiKey) {
        return res.status(401).json({ 
            success: false,
            error: 'API key requerida. Incluye x-api-key en headers o api_key como parámetro.' 
        });
    }
    
    if (apiKey !== process.env.API_KEY) {
        console.log(`🚨 Intento de acceso no autorizado con key: ${apiKey.substring(0, 8)}...`);
        return res.status(403).json({ 
            success: false,
            error: 'API key inválida' 
        });
    }
    
    console.log(`✅ Acceso autorizado desde IP: ${req.ip}`);
    next();
};

// Variables globales
let client;
let isClientReady = false;
let qrCodeData = '';

// Configuración del cliente WhatsApp
const initializeWhatsApp = () => {
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "ferre-app-client",
            dataPath: './whatsapp-sessions'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    // Evento: QR Code generado
    client.on('qr', (qr) => {
        console.log('\n🔗 QR Code generado. Escanea con tu WhatsApp:');
        qrcode.generate(qr, { small: true });
        qrCodeData = qr;
        isClientReady = false;
    });

    // Evento: Cliente autenticado
    client.on('authenticated', () => {
        console.log('✅ Cliente autenticado correctamente');
    });

    // Evento: Autenticación fallida
    client.on('auth_failure', (msg) => {
        console.error('❌ Error de autenticación:', msg);
        isClientReady = false;
    });

    // Evento: Cliente listo
    client.on('ready', () => {
        console.log('🚀 Cliente WhatsApp listo!');
        isClientReady = true;
        qrCodeData = '';
    });

    // Evento: Cliente desconectado
    client.on('disconnected', (reason) => {
        console.log('🔌 Cliente desconectado:', reason);
        isClientReady = false;
        
        // Reintentar conexión después de 5 segundos
        setTimeout(() => {
            console.log('🔄 Reintentando conexión...');
            initializeWhatsApp();
        }, 5000);
    });

    // Evento: Mensaje recibido (opcional - para logs)
    client.on('message', (message) => {
        console.log(`📨 Mensaje recibido de ${message.from}: ${message.body}`);
    });

    // Inicializar cliente
    client.initialize();
};

// Función para validar número de teléfono
const validatePhoneNumber = (phoneNumber) => {
    // Remover caracteres no numéricos excepto el +
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    // Validar formato básico
    if (cleaned.length < 10 || cleaned.length > 15) {
        return null;
    }
    
    // Si no tiene @c.us al final, agregarlo
    return cleaned.endsWith('@c.us') ? cleaned : `${cleaned}@c.us`;
};

// Función para formatear mensaje de error
const formatErrorResponse = (error, message = 'Error interno del servidor') => {
    console.error('❌ Error:', error);
    return {
        success: false,
        error: message,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
    };
};

// Función para extraer ID del mensaje de forma segura
const getMessageId = (response) => {
    try {
        if (response && response.id) {
            return response.id.id || response.id._serialized || response.id.toString() || 'unknown';
        }
        return 'unknown';
    } catch (error) {
        console.log('⚠️ No se pudo extraer el ID del mensaje:', error.message);
        return 'unknown';
    }
};

// RUTAS DE LA API

// Ruta pública: Información básica del servidor (sin autenticación)
app.get('/', (req, res) => {
    res.json({
        message: 'WhatsApp Web.js API - Servidor funcionando',
        version: '1.0.0',
        authentication: 'API Key requerida para endpoints protegidos',
        docs: 'Contacta al administrador para obtener acceso'
    });
});

// Ruta pública: Health check (sin autenticación)
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// APLICAR MIDDLEWARE DE AUTENTICACIÓN A TODAS LAS RUTAS PROTEGIDAS
app.use('/api', authenticateAPI);

// Ruta: Estado del servicio
app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        connected: isClientReady,
        qrCode: qrCodeData,
        timestamp: new Date().toISOString()
    });
});

// Ruta: Obtener QR Code
app.get('/api/whatsapp/qr', (req, res) => {
    if (qrCodeData) {
        res.json({
            success: true,
            qrCode: qrCodeData,
            message: 'Escanea el código QR con tu WhatsApp'
        });
    } else if (isClientReady) {
        res.json({
            success: true,
            message: 'Cliente ya está conectado'
        });
    } else {
        res.json({
            success: false,
            message: 'QR Code no disponible. Reinicia el servicio.'
        });
    }
});

// Ruta: Enviar mensaje de texto
app.post('/api/whatsapp/send-text', async (req, res) => {
    try {
        const { phoneNumber, message } = req.body;

        // Validaciones
        if (!phoneNumber || !message) {
            return res.status(400).json({
                success: false,
                error: 'phoneNumber y message son requeridos'
            });
        }

        if (!isClientReady) {
            return res.status(503).json({
                success: false,
                error: 'Cliente WhatsApp no está listo. Verifica la conexión.'
            });
        }

        // Validar y formatear número
        const validatedNumber = validatePhoneNumber(phoneNumber);
        if (!validatedNumber) {
            return res.status(400).json({
                success: false,
                error: 'Número de teléfono inválido'
            });
        }

        // Verificar si el número existe en WhatsApp
        const numberId = await client.getNumberId(validatedNumber);
        if (!numberId) {
            return res.status(400).json({
                success: false,
                error: 'El número no está registrado en WhatsApp'
            });
        }

        // Enviar mensaje
        const response = await client.sendMessage(numberId._serialized, message);
        
        // Extraer ID del mensaje de forma segura
        const messageId = getMessageId(response);
        
        console.log(`✅ Mensaje enviado a ${phoneNumber}: ${message.substring(0, 50)}...`);
        
        res.json({
            success: true,
            messageId: messageId,
            message: 'Mensaje enviado correctamente',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json(formatErrorResponse(error, 'Error al enviar mensaje'));
    }
});

// Ruta: Enviar imagen
app.post('/api/whatsapp/send-image', async (req, res) => {
    try {
        const { phoneNumber, imagePath, caption = '' } = req.body;

        if (!phoneNumber || !imagePath) {
            return res.status(400).json({
                success: false,
                error: 'phoneNumber e imagePath son requeridos'
            });
        }

        if (!isClientReady) {
            return res.status(503).json({
                success: false,
                error: 'Cliente WhatsApp no está listo'
            });
        }

        // Validar número
        const validatedNumber = validatePhoneNumber(phoneNumber);
        if (!validatedNumber) {
            return res.status(400).json({
                success: false,
                error: 'Número de teléfono inválido'
            });
        }

        // Verificar si el archivo existe
        if (!fs.existsSync(imagePath)) {
            return res.status(400).json({
                success: false,
                error: 'Archivo de imagen no encontrado'
            });
        }

        // Crear media
        const media = MessageMedia.fromFilePath(imagePath);
        
        // Verificar número
        const numberId = await client.getNumberId(validatedNumber);
        if (!numberId) {
            return res.status(400).json({
                success: false,
                error: 'El número no está registrado en WhatsApp'
            });
        }

        // Enviar imagen
        const response = await client.sendMessage(numberId._serialized, media, { caption });
        
        // Extraer ID del mensaje de forma segura
        const messageId = getMessageId(response);
        
        console.log(`🖼️ Imagen enviada a ${phoneNumber}`);
        
        res.json({
            success: true,
            messageId: messageId,
            message: 'Imagen enviada correctamente',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json(formatErrorResponse(error, 'Error al enviar imagen'));
    }
});

// Ruta: Reiniciar cliente
app.post('/api/whatsapp/restart', async (req, res) => {
    try {
        if (client) {
            await client.destroy();
        }
        
        setTimeout(() => {
            initializeWhatsApp();
        }, 2000);
        
        res.json({
            success: true,
            message: 'Cliente reiniciado. Genera un nuevo QR code.'
        });
    } catch (error) {
        res.status(500).json(formatErrorResponse(error, 'Error al reiniciar cliente'));
    }
});

// Ruta: Información del servidor
app.get('/api/info', (req, res) => {
    res.json({
        service: 'WhatsApp Web.js API',
        version: '1.0.0',
        status: 'running',
        whatsapp_connected: isClientReady,
        authenticated: true,
        timestamp: new Date().toISOString()
    });
});

// Manejo de errores 404
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint no encontrado'
    });
});

// Manejo de errores globales
app.use((error, req, res, next) => {
    console.error('❌ Error no manejado:', error);
    res.status(500).json({
        success: false,
        error: 'Error interno del servidor'
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🌐 Servidor iniciado en http://localhost:${PORT}`);
    console.log(`🔐 API Key requerida: ${process.env.API_KEY ? 'Configurada ✅' : 'NO CONFIGURADA ❌'}`);
    console.log('📱 Inicializando cliente WhatsApp...');
    
    // Inicializar WhatsApp
    initializeWhatsApp();
});

// Manejo de cierre graceful
process.on('SIGINT', async () => {
    console.log('\n🛑 Cerrando servidor...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Terminando proceso...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});
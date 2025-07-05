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

// Variables globales
let client;
let isClientReady = false;
let qrCodeData = '';
let isInitializing = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Middleware de autenticación API Key
const authenticateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    console.log('🔐 Header recibido:', req.headers);
    const validApiKey = process.env.API_KEY;

    if (!validApiKey) {
        console.log('⚠️ Advertencia: API_KEY no configurada en variables de entorno');
        return next();
    }

    if (!apiKey) {
        return res.status(401).json({
            success: false,
            error: 'API Key requerida. Incluye el header X-API-Key o Authorization'
        });
    }

    if (apiKey !== validApiKey) {
        return res.status(403).json({
            success: false,
            error: 'API Key inválida'
        });
    }

    next();
};

// Función para verificar si el cliente está realmente listo
const isClientActuallyReady = async () => {
    if (!client || !isClientReady) {
        return false;
    }
    
    try {
        // Verificar que la página de Puppeteer esté activa
        if (client.pupPage && client.pupPage.isClosed()) {
            console.log('⚠️ Página de Puppeteer cerrada');
            return false;
        }
        
        // Verificar estado del cliente
        const state = await client.getState();
        return state === 'CONNECTED';
    } catch (error) {
        console.log('⚠️ Error verificando estado del cliente:', error.message);
        return false;
    }
};

// Función para hacer operaciones de forma segura
const safeClientOperation = async (operation, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const ready = await isClientActuallyReady();
            if (!ready) {
                throw new Error('Cliente no está listo');
            }
            
            return await operation();
        } catch (error) {
            console.log(`🔄 Intento ${i + 1} fallido:`, error.message);
            
            if (i === maxRetries - 1) {
                throw error;
            }
            
            // Esperar antes de reintentar
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
    }
};

// Configuración del cliente WhatsApp optimizada para Railway
const initializeWhatsApp = async () => {
    if (isInitializing) {
        console.log('⏳ Ya se está inicializando el cliente...');
        return;
    }
    
    isInitializing = true;
    
    try {
        // Destruir cliente existente si existe
        if (client) {
            try {
                await client.destroy();
            } catch (error) {
                console.log('⚠️ Error al destruir cliente anterior:', error.message);
            }
        }

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
                    '--disable-gpu',
                    '--memory-pressure-off',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-features=TranslateUI',
                    '--disable-ipc-flooding-protection',
                    '--disable-extensions',
                    '--disable-default-apps',
                    '--disable-component-extensions-with-background-pages'
                ],
                timeout: 60000
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
            reconnectAttempts = 0; // Resetear contador de intentos
        });

        // Evento: Autenticación fallida
        client.on('auth_failure', (msg) => {
            console.error('❌ Error de autenticación:', msg);
            isClientReady = false;
            isInitializing = false;
        });

        // Evento: Cliente listo
        client.on('ready', () => {
            console.log('🚀 Cliente WhatsApp listo!');
            isClientReady = true;
            qrCodeData = '';
            isInitializing = false;
            reconnectAttempts = 0;
        });

        // Evento: Cliente desconectado
        client.on('disconnected', (reason) => {
            console.log('🔌 Cliente desconectado:', reason);
            isClientReady = false;
            isInitializing = false;
            
            // Implementar backoff exponencial para reconexión
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 30000);
                
                console.log(`🔄 Reintentando conexión (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) en ${delay/1000}s...`);
                
                setTimeout(() => {
                    initializeWhatsApp();
                }, delay);
            } else {
                console.error('❌ Máximo número de intentos de reconexión alcanzado');
            }
        });

        // Manejar errores de Puppeteer
        client.on('change_state', (state) => {
            console.log('🔄 Estado cambiado:', state);
        });

        // Inicializar cliente
        await client.initialize();
        
    } catch (error) {
        console.error('❌ Error al inicializar cliente:', error);
        isInitializing = false;
        isClientReady = false;
        
        // Reintentar después de un delay
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            setTimeout(() => {
                initializeWhatsApp();
            }, 10000);
        }
    }
};

// Función para validar número de teléfono
const validatePhoneNumber = (phoneNumber) => {
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    if (cleaned.length < 10 || cleaned.length > 15) {
        return null;
    }
    
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

// Ruta raíz
app.get('/', (req, res) => {
    res.json({
        message: 'Servidor WhatsApp Web.js está funcionando',
        status: isClientReady ? 'Conectado' : 'Desconectado',
        authentication: process.env.API_KEY ? 'Activada' : 'Desactivada',
        reconnectAttempts: reconnectAttempts,
        endpoints: {
            status: 'GET /api/whatsapp/status',
            qr: 'GET /api/whatsapp/qr',
            sendText: 'POST /api/whatsapp/send-text',
            sendImage: 'POST /api/whatsapp/send-image',
            restart: 'POST /api/whatsapp/restart'
        },
        authentication_note: process.env.API_KEY ? 'Endpoints protegidos requieren X-API-Key header' : 'Sin autenticación requerida'
    });
});

// Aplicar middleware de autenticación
app.use('/api', authenticateApiKey);

// Ruta: Estado del servicio
app.get('/api/whatsapp/status', async (req, res) => {
    const actuallyReady = await isClientActuallyReady();
    res.json({
        connected: actuallyReady,
        clientReady: isClientReady,
        qrCode: qrCodeData,
        reconnectAttempts: reconnectAttempts,
        isInitializing: isInitializing,
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

        if (!phoneNumber || !message) {
            return res.status(400).json({
                success: false,
                error: 'phoneNumber y message son requeridos'
            });
        }

        const validatedNumber = validatePhoneNumber(phoneNumber);
        if (!validatedNumber) {
            return res.status(400).json({
                success: false,
                error: 'Número de teléfono inválido'
            });
        }

        // Usar la función segura para operaciones
        const result = await safeClientOperation(async () => {
            // Verificar si el número existe en WhatsApp
            const numberId = await client.getNumberId(validatedNumber);
            if (!numberId) {
                throw new Error('El número no está registrado en WhatsApp');
            }

            // Enviar mensaje
            const response = await client.sendMessage(numberId._serialized, message);
            return response;
        });

        const messageId = getMessageId(result);
        
        console.log(`✅ Mensaje enviado a ${phoneNumber}: ${message.substring(0, 50)}...`);
        
        res.json({
            success: true,
            messageId: messageId,
            message: 'Mensaje enviado correctamente',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        if (error.message.includes('El número no está registrado')) {
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }
        
        if (error.message.includes('Cliente no está listo') || error.message.includes('Session closed')) {
            return res.status(503).json({
                success: false,
                error: 'Cliente WhatsApp no está listo. Intenta nuevamente en unos segundos.'
            });
        }
        
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

        const validatedNumber = validatePhoneNumber(phoneNumber);
        if (!validatedNumber) {
            return res.status(400).json({
                success: false,
                error: 'Número de teléfono inválido'
            });
        }

        if (!fs.existsSync(imagePath)) {
            return res.status(400).json({
                success: false,
                error: 'Archivo de imagen no encontrado'
            });
        }

        // Usar la función segura para operaciones
        const result = await safeClientOperation(async () => {
            const media = MessageMedia.fromFilePath(imagePath);
            
            const numberId = await client.getNumberId(validatedNumber);
            if (!numberId) {
                throw new Error('El número no está registrado en WhatsApp');
            }

            const response = await client.sendMessage(numberId._serialized, media, { caption });
            return response;
        });

        const messageId = getMessageId(result);
        
        console.log(`🖼️ Imagen enviada a ${phoneNumber}`);
        
        res.json({
            success: true,
            messageId: messageId,
            message: 'Imagen enviada correctamente',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        if (error.message.includes('El número no está registrado')) {
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }
        
        if (error.message.includes('Cliente no está listo') || error.message.includes('Session closed')) {
            return res.status(503).json({
                success: false,
                error: 'Cliente WhatsApp no está listo. Intenta nuevamente en unos segundos.'
            });
        }
        
        res.status(500).json(formatErrorResponse(error, 'Error al enviar imagen'));
    }
});

// Ruta: Reiniciar cliente
app.post('/api/whatsapp/restart', async (req, res) => {
    try {
        console.log('🔄 Reiniciando cliente...');
        
        if (client) {
            await client.destroy();
        }
        
        // Resetear variables
        isClientReady = false;
        isInitializing = false;
        reconnectAttempts = 0;
        qrCodeData = '';
        
        // Reinicializar después de un breve delay
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
app.get('/api/info', async (req, res) => {
    const actuallyReady = await isClientActuallyReady();
    res.json({
        service: 'WhatsApp Web.js API',
        version: '1.0.0',
        status: 'running',
        whatsapp_connected: actuallyReady,
        whatsapp_ready: isClientReady,
        authentication: process.env.API_KEY ? 'enabled' : 'disabled',
        reconnectAttempts: reconnectAttempts,
        isInitializing: isInitializing,
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
    console.log(`🔐 Autenticación: ${process.env.API_KEY ? 'ACTIVADA' : 'DESACTIVADA'}`);
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

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
    // No terminar el proceso inmediatamente, intentar recuperarse
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rechazada no manejada:', reason);
    // No terminar el proceso inmediatamente, intentar recuperarse
});
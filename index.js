const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // <-- ERROR CORREGIDO

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
const SECRET_KEY = "ignacio_clave_super_secreta_2026";
const MASTER_KEY = "12062002"; // <--- Cambia esto por algo difícil
app.use(cors());
app.use(express.json());

// 1. Servir archivos estáticos de la carpeta public
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------
// 1. ESQUEMAS DE BASE DE DATOS (MONGODB)
// ---------------------------------------------
const empleadoSchema = new mongoose.Schema({
    empresa_id: { type: String, required: true }, // <--- EL NUEVO SELLO MÁGICO
    uid: { type: String, unique: true },
    nombre: String,
    foto: String,
    email: { type: String, unique: true },
    password: String,
    rol: { type: String, default: 'usuario' }
});
const Empleado = mongoose.model('Empleado', empleadoSchema);

const registroSchema = new mongoose.Schema({
    empresa_id: { type: String, required: true }, // <--- EL NUEVO SELLO MÁGICO
    uid: String,
    nombre: String,
    foto: String,
    fechaHora: { type: Date, default: Date.now },
    tipo: String,
    estado: String
});
const Registro = mongoose.model('Registro', registroSchema);

// Esquema para persistir los ajustes
const ajustesSchema = new mongoose.Schema({
    empresa_id: { type: String, required: true }, // <--- EL SELLO MÁGICO
    limitesHorarios: {
        manana: { type: Number, default: 9.0 },
        tarde: { type: Number, default: 15.0 },
        noche: { type: Number, default: 18.0 },
        tolerancia: { type: Number, default: 15 }
    },
    ajustesEmpresa: {
        diasLaborables: { type: [Boolean], default: [false, true, true, true, true, true, true] },
        feriados: [String],
        branding: {
            nombreEmpresa: { type: String, default: 'Centro de Control' },
            logoUrl: { type: String, default: '' },
            temaPorDefecto: { type: String, default: 'dark' }
        },
        tiempoBloqueo: { type: Number, default: 5 }
    }
});
const Ajustes = mongoose.model('Ajustes', ajustesSchema);
// ---------------------------------------------
// 2. INICIALIZADOR DEL SISTEMA
// ---------------------------------------------
async function crearAdminPorDefecto() {
    const adminExiste = await Empleado.findOne({ email: 'admin@asistencia.com' });
    if (!adminExiste) {
        await Empleado.create({
            empresa_id: 'EMPRESA_GLOBAL', // Le asignamos un ID a tu cuenta maestra
            uid: 'ADMIN_000', nombre: 'Administrador',
            foto: 'https://cdn-icons-png.flaticon.com/512/149/149071.png',
            email: 'admin@asistencia.com', password: 'admin', rol: 'admin'
        });
        console.log('✅ Cuenta Administrador creada (admin@asistencia.com / admin)');
    }
}

mongoose.connect('mongodb+srv://ignacio:12062002@cluster0.kpzeiq3.mongodb.net/control_asistencia?appName=Cluster0')
    .then(async () => {
        console.log('✅ Conectado a MongoDB Atlas');
        crearAdminPorDefecto();
    })
    .catch(err => console.error('Error al conectar a MongoDB', err));
    
// ---------------------------------------------
// 3. RUTAS DE SEGURIDAD (LOGIN)
// ---------------------------------------------
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const usuario = await Empleado.findOne({ email: email, password: password });
    
    if (!usuario) {
        return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }
    const token = jwt.sign({ id: usuario._id, rol: usuario.rol, uid: usuario.uid, empresa_id: usuario.empresa_id }, SECRET_KEY);
    res.json({ token: token, rol: usuario.rol, nombre: usuario.nombre });
});

const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ error: 'Acceso denegado' });
    try {
        req.usuario = jwt.verify(token, SECRET_KEY);
        next();
    } catch (error) { res.status(401).json({ error: 'Token inválido' }); }
};

// ---------------------------------------------
// 4. RUTAS DEL HARDWARE (ESP32)
// ---------------------------------------------
app.post('/api/asistencia', async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ error: 'Falta el UID' });

        const empleado = await Empleado.findOne({ uid: uid });
        if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });

        // 🛑 NUEVO: CARGAR AJUSTES DE LA EMPRESA DEL EMPLEADO
        let config = await Ajustes.findOne({ empresa_id: empleado.empresa_id });
        if (!config) config = new Ajustes({ empresa_id: empleado.empresa_id }); // Carga defaults
        
        const lim = config.limitesHorarios;
        const reglas = config.ajustesEmpresa;

        // --- FILTRO ANTI-DOBLE MARCADO ---
        const ultimoRegistroBloqueo = await Registro.findOne({ uid: uid }).sort({ fechaHora: -1 });
        
        if (ultimoRegistroBloqueo) {
            const ahora = new Date();
            const diferenciaMinutos = (ahora - new Date(ultimoRegistroBloqueo.fechaHora)) / (1000 * 60);

            if (diferenciaMinutos < reglas.tiempoBloqueo) {
                console.log(`🚫 Marcado duplicado ignorado para UID: ${uid}`);
                return res.json({ mensaje: 'Bloqueo anti-duplicado', bloqueado: true });
            }
        }

        const inicioDia = new Date();
        inicioDia.setUTCHours(4, 0, 0, 0); 

        const ultimoRegistro = await Registro.findOne({
            uid: empleado.uid, fechaHora: { $gte: inicioDia }
        }).sort({ fechaHora: -1 });

        let tipoMarcado = (ultimoRegistro && ultimoRegistro.tipo === 'INGRESO') ? 'SALIDA' : 'INGRESO'; 
        
        let estadoAsistencia = 'PUNTUAL';
        let horaLimiteBase = 0;

        if (tipoMarcado === 'INGRESO') {
            const horaActual = new Date();
            horaActual.setUTCHours(horaActual.getUTCHours() - 4); 
            const horaDecimal = horaActual.getUTCHours() + (horaActual.getUTCMinutes() / 60);
            
            if (horaDecimal >= 4 && horaDecimal < 12) horaLimiteBase = lim.manana;
            else if (horaDecimal >= 12 && horaDecimal < 18) horaLimiteBase = lim.tarde;
            else horaLimiteBase = lim.noche;

            const limiteFinalConTolerancia = horaLimiteBase + (lim.tolerancia / 60);
            if (horaDecimal > limiteFinalConTolerancia) estadoAsistencia = 'RETRASO';
        }

        const nuevoRegistro = new Registro({ 
            empresa_id: empleado.empresa_id,
            uid: empleado.uid, 
            nombre: empleado.nombre, 
            foto: empleado.foto,
            tipo: tipoMarcado,
            estado: estadoAsistencia
        });
        
        await nuevoRegistro.save();
        io.emit('nueva_asistencia', { nombre: nuevoRegistro.nombre, estado: nuevoRegistro.estado });
        res.status(200).json({ mensaje: 'Asistencia registrada', tipo: tipoMarcado });

    } catch (error) { res.status(500).json({ error: 'Error del servidor' }); }
});

// ---------------------------------------------
// 5. RUTAS DEL DASHBOARD WEB
// ---------------------------------------------
// Obtener registros (Con filtros avanzados de Día, Mes, AÑO y Nombre)
app.get('/api/registros', verificarToken, async (req, res) => {
    const { mes, dia, anio, busqueda } = req.query;
    
    // 🛑 EL GRAN FILTRO SAAS: Nadie ve datos fuera de su empresa
    let filtro = { empresa_id: req.usuario.empresa_id }; 

    // Si es un "usuario" normal, SOLO puede ver sus propios registros
    if (req.usuario.rol === 'usuario') {
        filtro.uid = req.usuario.uid;
    }

    // Filtro por búsqueda de nombre
    if (busqueda) {
        filtro.nombre = { $regex: busqueda, $options: 'i' };
    }

    // Filtros de Fechas (Ajustado para UTC-4, Bolivia)
    if (dia) {
        // Busca un día exacto
        const fechaInicio = new Date(`${dia}T04:00:00.000Z`);
        const fechaFin = new Date(fechaInicio);
        fechaFin.setDate(fechaFin.getDate() + 1);
        filtro.fechaHora = { $gte: fechaInicio, $lt: fechaFin };
        
    } else if (mes) {
        // Busca un mes exacto (formato YYYY-MM)
        const fechaInicio = new Date(`${mes}-01T04:00:00.000Z`);
        const fechaFin = new Date(fechaInicio);
        fechaFin.setMonth(fechaFin.getMonth() + 1);
        filtro.fechaHora = { $gte: fechaInicio, $lt: fechaFin };
        
    } else if (anio) {
        // 🛑 NUEVO: Busca un AÑO completo (Desde el 1 de enero hasta el 1 de enero del próximo año)
        const fechaInicio = new Date(`${anio}-01-01T04:00:00.000Z`);
        const fechaFin = new Date(`${parseInt(anio) + 1}-01-01T04:00:00.000Z`);
        filtro.fechaHora = { $gte: fechaInicio, $lt: fechaFin };
    }

    try {
        const registros = await Registro.find(filtro).sort({ fechaHora: -1 });
        res.json(registros);
    } catch (error) {
        res.status(500).json({ error: 'Error al buscar registros' });
    }
});

app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.delete('/api/registros/:id', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    await Registro.findByIdAndDelete(req.params.id);
    res.json({ mensaje: 'Eliminado' });
});

app.get('/api/empleados', verificarToken, async (req, res) => {
    if (req.usuario.rol === 'admin') {
        // El admin ve a todos
        const empleados = await Empleado.find({ empresa_id: req.usuario.empresa_id });
        res.json(empleados);
    } else {
        // El usuario normal SOLO se ve a sí mismo
        const empleados = await Empleado.find({ uid: req.usuario.uid });
        res.json(empleados);
    }
});

app.post('/api/empleados', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    try {
        // Le asignamos automáticamente el empresa_id del admin que lo está creando
        const datosEmpleado = { ...req.body, empresa_id: req.usuario.empresa_id };
        const nuevoEmpleado = new Empleado(datosEmpleado);
        await nuevoEmpleado.save();
        res.status(201).json({ mensaje: 'Empleado creado con éxito' });
    } catch (error) { res.status(400).json({ error: 'El UID o Email ya existen' }); }
});

app.delete('/api/empleados/:id', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    await Empleado.findByIdAndDelete(req.params.id);
    res.json({ mensaje: 'Empleado eliminado' });
});

// Leer Ajustes
// --- RUTAS DE AJUSTES SAAS (Aisladas por empresa) ---

// 1. Leer Horarios
app.get('/api/ajustes', verificarToken, async (req, res) => {
    let config = await Ajustes.findOne({ empresa_id: req.usuario.empresa_id });
    if (!config) config = new Ajustes({ empresa_id: req.usuario.empresa_id }); // Valores por defecto
    res.json(config.limitesHorarios);
});

// 2. Guardar Horarios
app.post('/api/ajustes', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    await Ajustes.findOneAndUpdate(
        { empresa_id: req.usuario.empresa_id },
        { $set: { limitesHorarios: req.body } },
        { upsert: true }
    );
    res.json({ mensaje: 'Horarios guardados' });
});

// 3. Leer Reglas y Logos
app.get('/api/ajustes/empresa', verificarToken, async (req, res) => {
    let config = await Ajustes.findOne({ empresa_id: req.usuario.empresa_id });
    if (!config) config = new Ajustes({ empresa_id: req.usuario.empresa_id }); // Valores por defecto
    res.json(config.ajustesEmpresa);
});

// 4. Guardar Reglas y Logos
app.post('/api/ajustes/empresa', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    await Ajustes.findOneAndUpdate(
        { empresa_id: req.usuario.empresa_id },
        { $set: { ajustesEmpresa: req.body } },
        { upsert: true }
    );
    res.json({ mensaje: 'Reglas guardadas' });
});

// NUEVA RUTA: Asignar estado manual (Admin)
app.post('/api/registros/manual', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });

    const { uid, nombre, fecha, estado } = req.body;

    try {
        // Definimos el rango del día (UTC-4 Bolivia)
        const fechaInicio = new Date(`${fecha}T04:00:00.000Z`);
        const fechaFin = new Date(fechaInicio);
        fechaFin.setDate(fechaFin.getDate() + 1);

        // Buscamos si ya existe un registro ese día para ese usuario
        // Si existe lo actualizamos, si no, creamos uno nuevo.
        const filtro = { 
            uid: uid, 
            fechaHora: { $gte: fechaInicio, $lt: fechaFin } 
        };

        const actualizacion = { 
            empresa_id: req.usuario.empresa_id, // <--- EL SELLO FALTANTE
            uid, 
            nombre, 
            estado, 
            tipo: 'MANUAL', 
            fechaHora: fechaInicio 
        };

        await Registro.findOneAndUpdate(filtro, actualizacion, { upsert: true, new: true });

        res.json({ mensaje: `Estado ${estado} asignado correctamente` });
    } catch (error) {
        res.status(500).json({ error: 'Error al asignar estado manual' });
    }
});

// =============================================
// 🚀 RUTA MAESTRA: CREACIÓN DE NUEVAS EMPRESAS
// =============================================
app.post('/api/master/crear-empresa', async (req, res) => {
    const { masterKey, nombreEmpresa, emailAdmin, passwordAdmin } = req.body;

    // 1. Verificamos que tú seas el que da la orden
    if (masterKey !== MASTER_KEY) {
        return res.status(403).json({ error: "No tienes permiso para crear empresas" });
    }

    try {
        // 2. Generamos un empresa_id único basado en el nombre (ej: "Ferretería" -> "FERRETERIA_123")
        const empresaId = nombreEmpresa.toUpperCase().replace(/\s+/g, '_') + "_" + Math.floor(1000 + Math.random() * 9000);

        // 3. Verificamos si el correo ya existe
        const existe = await Empleado.findOne({ email: emailAdmin });
        if (existe) return res.status(400).json({ error: "Ese correo ya está registrado" });

        // 4. Creamos al Administrador de la nueva empresa
        const nuevoAdmin = new Empleado({
            empresa_id: empresaId,
            uid: `ADMIN_${Math.floor(Math.random() * 999)}`,
            nombre: `Admin ${nombreEmpresa}`,
            email: emailAdmin,
            password: passwordAdmin,
            rol: 'admin',
            foto: 'https://cdn-icons-png.flaticon.com/512/149/149071.png'
        });

        // 5. Creamos los Ajustes iniciales para esa empresa (Branding)
        const nuevosAjustes = new Ajustes({
            empresa_id: empresaId,
            ajustesEmpresa: {
                branding: {
                    nombreEmpresa: nombreEmpresa,
                    temaPorDefecto: 'dark'
                }
            }
        });

        await nuevoAdmin.save();
        await nuevosAjustes.save();

        res.json({
            mensaje: "¡Empresa creada con éxito!",
            detalles: {
                nombre: nombreEmpresa,
                empresa_id: empresaId,
                acceso_admin: emailAdmin
            }
        });

    } catch (error) {
        res.status(500).json({ error: "Error al crear la empresa" });
    }
});

// =============================================
// 🗑️ RUTAS MAESTRAS: GESTIÓN Y BORRADO DE EMPRESAS
// =============================================

// 1. Listar todas las empresas activas
app.get('/api/master/empresas', async (req, res) => {
    // Para rutas GET/DELETE usamos headers en lugar del body
    const masterKey = req.headers['x-master-key'];
    if (masterKey !== MASTER_KEY) return res.status(403).json({ error: "No autorizado" });

    try {
        // Buscamos todas las configuraciones para sacar la lista de empresas
        const empresas = await Ajustes.find({}, 'empresa_id ajustesEmpresa.branding.nombreEmpresa');
        res.json(empresas);
    } catch (error) {
        res.status(500).json({ error: "Error al listar empresas" });
    }
});

// 2. Eliminar una empresa (BORRADO EN CASCADA)
app.delete('/api/master/empresas/:id', async (req, res) => {
    const masterKey = req.headers['x-master-key'];
    if (masterKey !== MASTER_KEY) return res.status(403).json({ error: "No autorizado" });

    const empresaId = req.params.id;

    // 🛡️ ESCUDO: Evita que borres tu propia cuenta maestra por accidente
    if (empresaId === 'EMPRESA_GLOBAL') {
        return res.status(400).json({ error: "No puedes eliminar tu cuenta matriz principal" });
    }

    try {
        // Eliminamos TODO lo que tenga el sello de esa empresa
        await Empleado.deleteMany({ empresa_id: empresaId });
        await Registro.deleteMany({ empresa_id: empresaId });
        await Ajustes.deleteOne({ empresa_id: empresaId });

        res.json({ mensaje: "Empresa eliminada por completo" });
    } catch (error) {
        res.status(500).json({ error: "Error al eliminar la empresa" });
    }
});

server.listen(PORT, () => console.log(`🚀 Servidor con Sockets en puerto ${PORT}`));
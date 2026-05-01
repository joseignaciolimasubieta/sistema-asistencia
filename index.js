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
// --- MEMORIA DE TURNOS ---
let limitesHorarios = {
    manana: 9.0,   // 09:00
    tarde: 15.0,   // 03:00 PM
    noche: 18.0,   // 06:00 PM
    tolerancia: 15 // Minutos
};
// --- NUEVO: REGLAS DE LA EMPRESA ---
let ajustesEmpresa = {
    diasLaborables: [false, true, true, true, true, true, true], 
    feriados: [],
    branding: {
        nombreEmpresa: 'Centro de Control',
        logoUrl: '',
        temaPorDefecto: 'dark'
    }
};
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
    configId: { type: String, default: 'global_config' }, // ID único para encontrarlo siempre
    limitesHorarios: {
        manana: Number,
        tarde: Number,
        noche: Number,
        tolerancia: Number
    },
    ajustesEmpresa: {
        diasLaborables: [Boolean],
        feriados: [String],
        // --- NUEVOS CAMPOS DE BRANDING ---
        branding: {
            nombreEmpresa: { type: String, default: 'Centro de Control' },
            logoUrl: { type: String, default: '' },
            temaPorDefecto: { type: String, default: 'dark' }
        },
        tiempoBloqueo: { type: Number, default: 5 } // <--- NUEVO: Minutos a ignorar
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
        
        // Buscamos los ajustes guardados en la base de datos
        const configGuardada = await Ajustes.findOne({ configId: 'global_config' });
        if (configGuardada) {
            if (configGuardada.limitesHorarios) limitesHorarios = configGuardada.limitesHorarios;
            if (configGuardada.ajustesEmpresa) ajustesEmpresa = configGuardada.ajustesEmpresa;
            console.log('📂 Configuración recuperada de la base de datos exitosamente');
        }
        
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

        // --- NUEVO: FILTRO ANTI-DOBLE MARCADO ---
        const ultimoRegistroBloqueo = await Registro.findOne({ uid: uid }).sort({ fechaHora: -1 });
        
        if (ultimoRegistroBloqueo) {
            const ahora = new Date();
            const diferenciaMinutos = (ahora - new Date(ultimoRegistroBloqueo.fechaHora)) / (1000 * 60);

            // Si el tiempo pasado es menor al configurado, ignoramos el envío
            if (diferenciaMinutos < ajustesEmpresa.tiempoBloqueo) {
                console.log(`🚫 Marcado duplicado ignorado para UID: ${uid} (hace ${Math.round(diferenciaMinutos)} min)`);
                return res.json({ 
                    mensaje: 'Registro ignorado (Bloqueo anti-duplicado activo)',
                    bloqueado: true 
                });
            }
        }
        // ----------------------------------------

        const inicioDia = new Date();
        inicioDia.setUTCHours(4, 0, 0, 0); 

        const ultimoRegistro = await Registro.findOne({
            uid: empleado.uid, fechaHora: { $gte: inicioDia }
        }).sort({ fechaHora: -1 });

        let tipoMarcado = (ultimoRegistro && ultimoRegistro.tipo === 'INGRESO') ? 'SALIDA' : 'INGRESO'; 
        // 3.5. Lógica de Turnos con Tolerancia Configurable
        let estadoAsistencia = 'PUNTUAL';
        let horaLimiteBase = 0;

        if (tipoMarcado === 'INGRESO') {
            const horaActual = new Date();
            horaActual.setUTCHours(horaActual.getUTCHours() - 4); // Ajuste Bolivia (-4)
            
            const horaDecimal = horaActual.getUTCHours() + (horaActual.getUTCMinutes() / 60);
            
            // Identificamos el turno según la hora del día
            if (horaDecimal >= 4 && horaDecimal < 12) {
                horaLimiteBase = limitesHorarios.manana;
            } else if (horaDecimal >= 12 && horaDecimal < 18) {
                horaLimiteBase = limitesHorarios.tarde;
            } else {
                horaLimiteBase = limitesHorarios.noche;
            }

            // MATEMÁTICA: Sumamos la tolerancia a la hora base
            const limiteFinalConTolerancia = horaLimiteBase + (limitesHorarios.tolerancia / 60);

            if (horaDecimal > limiteFinalConTolerancia) {
                estadoAsistencia = 'RETRASO';
            }
        }

        // 4. Guardamos el registro con el sello de la empresa
        const nuevoRegistro = new Registro({ 
            empresa_id: empleado.empresa_id, // <--- HEREDA LA EMPRESA DEL EMPLEADO
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
        const empleados = await Empleado.find();
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
app.get('/api/ajustes', verificarToken, (req, res) => {
    res.json(limitesHorarios);
});

// Guardar Ajustes (Solo Admin) - AHORA GUARDA EN MONGODB
app.post('/api/ajustes', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    
    try {
        await Ajustes.findOneAndUpdate(
            { configId: 'global_config' },
            { $set: { limitesHorarios: req.body } },
            { upsert: true }
        );
        // También actualizamos la variable en memoria para que el cambio sea instantáneo
        limitesHorarios = req.body; 
        res.json({ mensaje: 'Ajustes guardados en base de datos' });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar' });
    }
});

// Rutas para Reglas de Empresa
app.get('/api/ajustes/empresa', verificarToken, (req, res) => {
    res.json(ajustesEmpresa);
});

// Guardar Reglas de Empresa (Días y Feriados) - AHORA GUARDA EN MONGODB
app.post('/api/ajustes/empresa', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    
    try {
        await Ajustes.findOneAndUpdate(
            { configId: 'global_config' },
            { $set: { ajustesEmpresa: req.body } },
            { upsert: true }
        );
        ajustesEmpresa = req.body;
        res.json({ mensaje: 'Reglas de empresa persistidas' });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar reglas' });
    }
});

app.post('/api/ajustes/empresa', verificarToken, (req, res) => {
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    ajustesEmpresa = req.body;
    res.json({ mensaje: 'Reglas actualizadas' });
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
            uid, 
            nombre, 
            estado, 
            tipo: 'MANUAL', // Marcamos que fue puesto por el admin
            fechaHora: fechaInicio 
        };

        await Registro.findOneAndUpdate(filtro, actualizacion, { upsert: true, new: true });

        res.json({ mensaje: `Estado ${estado} asignado correctamente` });
    } catch (error) {
        res.status(500).json({ error: 'Error al asignar estado manual' });
    }
});

server.listen(PORT, () => console.log(`🚀 Servidor con Sockets en puerto ${PORT}`));
const headersSeguros = { 'Authorization': sessionStorage.getItem('token'), 'Content-Type': 'application/json' };
const rolUsuario = sessionStorage.getItem('rol');
let miGraficoDona = null;

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const isMobile = window.innerWidth <= 768;
    if (isMobile) sidebar.classList.toggle('active');
    else sidebar.classList.toggle('colapsado');
}

window.onload = async () => {
    const socket = io();
    
    // 🔐 DECODIFICAR EL TOKEN PARA SABER A QUÉ SALA UNIRNOS
    const token = sessionStorage.getItem('token');
    if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        socket.emit('unirse_empresa', payload.empresa_id); // Nos metemos a nuestra sala privada
    }

    socket.on('nueva_asistencia', () => { cargarDatos(); if (rolUsuario === 'admin') cargarDatosMatriz(); });

    socket.on('tarjeta_desconocida', (data) => {
        // 1. Forzamos a que se abra la ventana de registro automáticamente
        abrirModal();
        
        // 2. Llenamos el input con el UID que leyó el ESP32
        document.getElementById('emp-uid').value = data.uid;
        
        // 3. Mostramos la alerta de éxito
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
        Toast.fire({ icon: 'success', title: '¡Nueva tarjeta detectada!' });
    });
    
    cambiarTema(true);
    if(rolUsuario === 'admin') {
        document.getElementById('tab-matriz').style.display = 'flex';
        document.getElementById('tab-emp').style.display = 'flex';
        document.getElementById('tab-ajustes').style.display = 'flex';
    }

    const hoy = new Date();
    const yyyy = hoy.getFullYear();
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const dd = String(hoy.getDate()).padStart(2, '0');
    const fechaHoy = `${yyyy}-${mm}-${dd}`; 
    const mesHoy = `${yyyy}-${mm}`;         

    // 🧠 MEMORIA: Recuperar filtros guardados o usar los de hoy
    document.getElementById('tipo-filtro').value = sessionStorage.getItem('filtro-tipo') || 'dia';
    cambiarTipoFiltro(); // Actualiza la vista para que coincida con el selector
    document.getElementById('filtro-dia').value = sessionStorage.getItem('filtro-dia') || fechaHoy;
    document.getElementById('filtro-mes').value = sessionStorage.getItem('filtro-mes') || mesHoy;
    document.getElementById('filtro-anio').value = sessionStorage.getItem('filtro-anio') || yyyy;
    document.getElementById('filtro-nombre').value = sessionStorage.getItem('filtro-nombre') || '';

    if (document.getElementById('matriz-mes-anio')) {
        document.getElementById('matriz-mes-anio').value = sessionStorage.getItem('filtro-matriz') || mesHoy;
    }

    cargarDatos();
    cargarBrandingGlobal(); 
    if (rolUsuario === 'admin') { 
        cargarAjustes(); 
        await cargarReglasEmpresa(); 
        cargarDatosMatriz(); 
    }
};

function cambiarSeccion(seccion) {
    const seccionesProhibidas = ['matriz', 'empleados', 'ajustes'];
    if (rolUsuario !== 'admin' && seccionesProhibidas.includes(seccion)) return; 

    // 🧠 Guardar la pestaña actual en memoria
    sessionStorage.setItem('seccionActiva', seccion);

    document.getElementById('seccion-asistencias').style.display = 'none';
    document.getElementById('seccion-matriz').style.display = 'none';
    document.getElementById('seccion-dashboard').style.display = 'none';
    document.getElementById('seccion-empleados').style.display = 'none';
    document.getElementById('seccion-ajustes').style.display = 'none';
    
    document.getElementById('tab-asist').className = 'tab-btn';
    document.getElementById('tab-matriz').className = 'tab-btn';
    document.getElementById('tab-dashboard').className = 'tab-btn';
    document.getElementById('tab-emp').className = 'tab-btn';
    document.getElementById('tab-ajustes').className = 'tab-btn';

    if(seccion === 'asistencias') { document.getElementById('seccion-asistencias').style.display = 'block'; document.getElementById('tab-asist').className = 'tab-btn activo'; }
    else if(seccion === 'matriz') { document.getElementById('seccion-matriz').style.display = 'block'; document.getElementById('tab-matriz').className = 'tab-btn activo'; }
    else if(seccion === 'dashboard') { document.getElementById('seccion-dashboard').style.display = 'block'; document.getElementById('tab-dashboard').className = 'tab-btn activo'; }
    else if(seccion === 'empleados') { document.getElementById('seccion-empleados').style.display = 'block'; document.getElementById('tab-emp').className = 'tab-btn activo'; cargarEmpleados(); }
    else if(seccion === 'ajustes') { document.getElementById('seccion-ajustes').style.display = 'block'; document.getElementById('tab-ajustes').className = 'tab-btn activo'; }
    
    if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('active');
}

// 🚀 EJECUCIÓN INMEDIATA
const seccionGuardada = sessionStorage.getItem('seccionActiva') || 'asistencias';
cambiarSeccion(seccionGuardada);

function cambiarTema(iniciar = false) {
    let temaActual = localStorage.getItem('tema') || 'dark';
    if (!iniciar) temaActual = temaActual === 'dark' ? 'light' : 'dark';
    
    if (temaActual === 'light') {
        document.body.setAttribute('data-theme', 'light');
    } else {
        document.body.removeAttribute('data-theme');
    }
    localStorage.setItem('tema', temaActual);

    // 🔄 ACTUALIZACIÓN DINÁMICA DE LA GRÁFICA
    if (typeof miGraficoDona !== 'undefined' && miGraficoDona !== null) {
        const colorTexto = temaActual === 'light' ? '#111111' : '#ffffff';
        miGraficoDona.options.plugins.legend.labels.color = colorTexto;
        miGraficoDona.update(); 
    }
}

function cerrarSesion() { sessionStorage.clear(); localStorage.clear(); window.location.replace('/login.html'); }

function cambiarTipoFiltro() {
    const tipo = document.getElementById('tipo-filtro').value;
    document.getElementById('filtro-dia').style.display = tipo === 'dia' ? 'block' : 'none';
    document.getElementById('filtro-mes').style.display = tipo === 'mes' ? 'block' : 'none';
    document.getElementById('filtro-anio').style.display = tipo === 'anio' ? 'block' : 'none';
}

async function cargarDatos() {
    const tipoFiltro = document.getElementById('tipo-filtro').value;
    const dia = document.getElementById('filtro-dia').value;
    const mes = document.getElementById('filtro-mes').value;
    const anio = document.getElementById('filtro-anio').value;
    const busqueda = document.getElementById('filtro-nombre').value;

    sessionStorage.setItem('filtro-tipo', tipoFiltro);
    sessionStorage.setItem('filtro-dia', dia);
    sessionStorage.setItem('filtro-mes', mes);
    sessionStorage.setItem('filtro-anio', anio);
    sessionStorage.setItem('filtro-nombre', busqueda);

    let url = `/api/registros?busqueda=${busqueda}`;
    
    if (!dia && !mes && !anio) {
        const hoy = new Date();
        const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
        url += `&mes=${mesActual}`;
    } else {
        if (tipoFiltro === 'dia' && dia) url += `&dia=${dia}`;
        if (tipoFiltro === 'mes' && mes) url += `&mes=${mes}`;
        if (tipoFiltro === 'anio' && anio) url += `&anio=${anio}`;
    }

    try {
        const res = await fetch(url, { headers: headersSeguros });
        if (res.status === 401 || res.status === 403) return cerrarSesion();
        const datos = await res.json();
        window.datosExcel = datos; 

        if (rolUsuario !== 'admin' && document.getElementById('pantalla-matriz')) {
            document.getElementById('pantalla-matriz').innerHTML = "<p style='color: var(--texto-secundario); padding: 20px;'>Tu resumen se muestra arriba.</p>";
        }
        
        const ingresos = datos.filter(reg => reg.tipo === 'INGRESO' || reg.tipo === 'MANUAL' || !reg.tipo);
        const salidas = datos.filter(reg => reg.tipo === 'SALIDA');
        let cPuntual = 0, cRetraso = 0, cFalta = 0, cPermiso = 0, cDescanso = 0, cComision = 0, cVacaciones = 0, cSesantia = 0;

        ingresos.forEach(reg => {
            const est = reg.estado || 'PUNTUAL';
            if (est === 'PUNTUAL' || est === 'ASISTENCIA') cPuntual++;
            else if (est === 'RETRASO') cRetraso++;
            else if (est === 'PERMISO') cPermiso++;
            else if (est === 'COMISION') cComision++;
            else if (est === 'VACACIONES') cVacaciones++;
            else if (est === 'SESANTIA') cSesantia++;
            else if (est === 'DESCANSO') cDescanso++;
            else if (est === 'FALTA' || est === 'FALTA INJUSTIFICADA') cFalta++;
        });

        if (document.getElementById('kpi-puntual')) {
            document.getElementById('kpi-puntual').innerText = cPuntual; document.getElementById('kpi-retraso').innerText = cRetraso;
            document.getElementById('kpi-falta').innerText = cFalta; document.getElementById('kpi-permiso').innerText = cPermiso;
            document.getElementById('kpi-descanso').innerText = cDescanso; document.getElementById('kpi-comision').innerText = cComision;
            document.getElementById('kpi-vacaciones').innerText = cVacaciones; document.getElementById('kpi-sesantia').innerText = cSesantia;
        }

        if (typeof dibujarGrafico === "function") dibujarGrafico(cPuntual, cRetraso, cFalta, cPermiso, cDescanso, cComision, cVacaciones, cSesantia);
        
        const tbodyIngresos = document.getElementById('tabla-ingresos');
        const tbodySalidas = document.getElementById('tabla-salidas');
        if(tbodyIngresos) tbodyIngresos.innerHTML = '';
        if(tbodySalidas) tbodySalidas.innerHTML = '';
        
        const crearFila = (reg) => {
            const fecha = new Date(reg.fechaHora).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
            const btnEliminar = rolUsuario === 'admin' ? `<button onclick="eliminarRegistro('${reg._id}')" class="btn-peligro" style="padding: 2px 6px; font-size:11px;">X</button>` : '';
            
            let textoEstado = reg.estado || 'PUNTUAL';
            let bgSober = '#10B981'; 
            let colorTextoBadge = '#ffffff';

            if (textoEstado === 'RETRASO') { bgSober = '#FBBF24'; colorTextoBadge = '#000000'; } 
            else if (textoEstado === 'FALTA' || textoEstado === 'FALTA INJUSTIFICADA') { bgSober = '#EF4444'; } 
            else if (textoEstado === 'PERMISO') { bgSober = '#3B82F6'; } 
            else if (textoEstado === 'DESCANSO') { bgSober = '#6B7280'; } 
            else if (textoEstado === 'COMISION') { bgSober = '#06B6D4'; } 
            else if (textoEstado === 'VACACIONES') { bgSober = '#8B5CF6'; } 
            else if (textoEstado === 'SESANTIA') { bgSober = '#cbd5e1'; colorTextoBadge = '#000000'; } 

            const badgeEstado = `<span style="background: ${bgSober}; color: ${colorTextoBadge}; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-left: 10px; border: none; letter-spacing: 0.5px;">${textoEstado}</span>`;
            const mostrarBadge = (reg.tipo === 'INGRESO' || reg.tipo === 'MANUAL' || !reg.tipo);

            return `<tr>
                    <td><div style="display:flex; align-items:center;">
                        <img src="${reg.foto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" class="avatar"> 
                        <span style="font-size: 13px;">${reg.nombre}</span> ${mostrarBadge ? badgeEstado : ''}</div></td>
                    <td style="font-size: 13px; color: var(--texto-secundario);">${fecha}</td>
                    <td>${btnEliminar}</td>
                </tr>`;
        };

        if(tbodyIngresos) ingresos.forEach(reg => tbodyIngresos.innerHTML += crearFila(reg));
        if(tbodySalidas) salidas.forEach(reg => tbodySalidas.innerHTML += crearFila(reg));

    } catch (error) { console.error("Error cargando datos", error); }
}

async function eliminarRegistro(id) {
    if(confirm('¿Confirmar purga del registro?')) {
        await fetch(`/api/registros/${id}`, { method: 'DELETE', headers: headersSeguros });
        cargarDatos();
    }
}

async function cargarEmpleados() {
    const res = await fetch('/api/empleados', { headers: headersSeguros });
    const empleados = await res.json();
    const tbody = document.getElementById('tabla-empleados');
    tbody.innerHTML = '';
    empleados.forEach(emp => {
        tbody.innerHTML += `<tr>
                <td><div style="display:flex; align-items:center;"><img src="${emp.foto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" class="avatar"> <span>${emp.nombre}</span></div></td>
                <td><span style="font-family: monospace; font-size: 12px; color: var(--texto-secundario);">${emp.uid}</span></td>
                <td style="font-size: 13px;">${emp.email}</td><td style="font-size: 12px; text-transform: uppercase;">${emp.rol}</td>
                <td><button onclick="borrarEmpleado('${emp._id}')" class="btn-peligro" style="padding: 4px 10px; font-size: 11px;">Eliminar</button></td>
            </tr>`;
    });
}

async function crearEmpleado(e) {
    e.preventDefault();
    const nuevoEmp = {
        nombre: document.getElementById('emp-nombre').value, uid: document.getElementById('emp-uid').value.toUpperCase(),
        email: document.getElementById('emp-email').value, password: document.getElementById('emp-pass').value,
        foto: document.getElementById('emp-foto').value, rol: document.getElementById('emp-rol').value
    };
    const res = await fetch('/api/empleados', { method: 'POST', headers: headersSeguros, body: JSON.stringify(nuevoEmp) });
    if(res.ok) { Swal.fire('Completado', 'Registro insertado', 'success'); cerrarModal(); cargarEmpleados(); } 
    else { Swal.fire('Error', 'Revise los datos. El UID o Email podría estar duplicado.', 'error'); }
}

async function borrarEmpleado(id) {
    if(confirm('¿Revocar acceso del usuario?')) { await fetch(`/api/empleados/${id}`, { method: 'DELETE', headers: headersSeguros }); cargarEmpleados(); }
}

function abrirModal() { document.getElementById('modal-empleado').style.display = 'flex'; }
function cerrarModal() { document.getElementById('modal-empleado').style.display = 'none'; document.getElementById('form-empleado').reset(); }

function dibujarMatriz(registros, empleados) {
    const valorCalendario = document.getElementById('matriz-mes-anio').value;
    const anioSel = parseInt(valorCalendario.split('-')[0]); const mesSel = parseInt(valorCalendario.split('-')[1]);
    const diasEnMes = new Date(anioSel, mesSel, 0).getDate();
    const nombresDias = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

    let tabla = `<table class="tabla-matriz"><thead><tr><th rowspan="2" class="columna-fija" style="vertical-align: middle;">Colaborador</th>`;
    for (let i = 1; i <= diasEnMes; i++) { tabla += `<th style="font-size: 9px; padding-bottom: 0;">${nombresDias[new Date(anioSel, mesSel - 1, i).getDay()]}</th>`; }
    tabla += `</tr><tr>`;
    for (let i = 1; i <= diasEnMes; i++) { tabla += `<th style="padding-top: 0;">${i}</th>`; }
    tabla += `</tr></thead><tbody>`;

    empleados.forEach(emp => {
        tabla += `<tr><td class="columna-fija" style="font-weight: normal;">${emp.nombre}</td>`;
        for (let d = 1; d <= diasEnMes; d++) {
            const reg = registros.find(r => {
                const f = new Date(r.fechaHora);
                return r.uid === emp.uid && f.getDate() === d && (f.getMonth() + 1) === mesSel && f.getFullYear() === anioSel && (r.tipo === 'INGRESO' || r.tipo === 'MANUAL');
            });
            let letra = '', claseCss = '';
            if (reg) {
                const est = reg.estado || 'PUNTUAL';
                if (est === 'PUNTUAL' || est === 'ASISTENCIA') { letra = 'A'; claseCss = 'bg-A'; }
                else if (est === 'RETRASO') { letra = 'R'; claseCss = 'bg-R'; }
                else if (est === 'FALTA' || est === 'FALTA INJUSTIFICADA') { letra = 'F'; claseCss = 'bg-F'; }
                else if (est === 'PERMISO') { letra = 'P'; claseCss = 'bg-P'; }
                else if (est === 'DESCANSO') { letra = 'D'; claseCss = 'bg-D'; }
                else if (est === 'COMISION') { letra = 'C'; claseCss = 'bg-C'; }
                else if (est === 'VACACIONES') { letra = 'V'; claseCss = 'bg-V'; }
                else if (est === 'SESANTIA') { letra = 'S'; claseCss = 'bg-S'; }
            } else {
                const fechaCelda = new Date(anioSel, mesSel - 1, d);
                if (fechaCelda < new Date()) {
                    const esLaborable = ajustesEmpresaLocal.diasLaborables ? ajustesEmpresaLocal.diasLaborables[fechaCelda.getDay()] : (fechaCelda.getDay() !== 0 && fechaCelda.getDay() !== 6);
                    const esFeriado = ajustesEmpresaLocal.feriados ? ajustesEmpresaLocal.feriados.includes(`${anioSel}-${String(mesSel).padStart(2, '0')}-${String(d).padStart(2, '0')}`) : false;
                    
                    if (esFeriado) { letra = 'D'; claseCss = 'bg-D'; } 
                    else if (!esLaborable) { letra = '-'; claseCss = 'bg-S'; } 
                    else { letra = 'F'; claseCss = 'bg-F'; }
                }
            }
            tabla += `<td class="${claseCss}" onclick="abrirSelectorManual('${emp.uid}', '${emp.nombre}', '${anioSel}-${String(mesSel).padStart(2, '0')}-${String(d).padStart(2, '0')}')" style="cursor: pointer;">${letra}</td>`;
        }
        tabla += `</tr>`;
    });
    document.getElementById('pantalla-matriz').innerHTML = tabla + `</tbody></table>`;
}

function descargarExcel() {
    const datosExportar = window.datosExcel || [];
    if(datosExportar.length === 0) return Swal.fire('Vacío', 'No hay datos.', 'info');

    const hoja = XLSX.utils.json_to_sheet(datosExportar.map(r => ({
        "Colaborador": r.nombre || 'Desconocido', "ID": r.uid || 'N/A', "Acción": r.tipo || 'INGRESO', "Estado": r.estado || 'PUNTUAL',
        "Fecha": new Date(r.fechaHora).toLocaleDateString('es-ES'), "Hora": new Date(r.fechaHora).toLocaleTimeString('es-ES')
    })));
    
    const rango = XLSX.utils.decode_range(hoja['!ref']);
    
    const coloresExcel = {
        'PUNTUAL': { bg: 'FF10B981', font: 'FFFFFFFF' }, 'ASISTENCIA': { bg: 'FF10B981', font: 'FFFFFFFF' },
        'RETRASO': { bg: 'FFFBBF24', font: 'FF000000' }, 'FALTA': { bg: 'FFEF4444', font: 'FFFFFFFF' }, 'FALTA INJUSTIFICADA': { bg: 'FFEF4444', font: 'FFFFFFFF' },
        'PERMISO': { bg: 'FF3B82F6', font: 'FFFFFFFF' }, 'COMISION': { bg: 'FF06B6D4', font: 'FFFFFFFF' }, 'VACACIONES': { bg: 'FF8B5CF6', font: 'FFFFFFFF' },
        'SESANTIA': { bg: 'FFCBD5E1', font: 'FF000000' }, 'DESCANSO': { bg: 'FF6B7280', font: 'FFFFFFFF' }
    };

    for (let R = rango.s.r; R <= rango.e.r; ++R) {
        for (let C = rango.s.c; C <= rango.e.c; ++C) {
            const celda = hoja[XLSX.utils.encode_cell({c: C, r: R})];
            if (!celda) continue;
            let estilo = { alignment: { horizontal: "center", vertical: "center" }, border: { top: { style: "thin", color: { rgb: "FF555555" } }, bottom: { style: "thin", color: { rgb: "FF555555" } }, left: { style: "thin", color: { rgb: "FF555555" } }, right: { style: "thin", color: { rgb: "FF555555" } } } };
            if (R === 0) { estilo.fill = { fgColor: { rgb: "FF0A0A0A" } }; estilo.font = { color: { rgb: "FFFFFFFF" }, bold: true }; } 
            else {
                estilo.font = { color: { rgb: "FF111111" } };
                if (C === 0) estilo.alignment.horizontal = "left";
                if (C === 3 && coloresExcel[celda.v]) { estilo.fill = { fgColor: { rgb: coloresExcel[celda.v].bg } }; estilo.font = { color: { rgb: coloresExcel[celda.v].font }, bold: true }; }
            }
            celda.s = estilo;
        }
    }
    hoja['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 15 }, { wch: 15 }];
    const libro = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(libro, hoja, "Data"); XLSX.writeFile(libro, `Export_${Date.now()}.xlsx`);
}

function cerrarMes() {
    const mes = document.getElementById('matriz-mes-anio').value; if (!mes) return Swal.fire('Falta mes', '', 'warning');
    Swal.fire({ title: 'Exportar Registro', icon: 'warning', showCancelButton: true, confirmButtonText: 'Exportar' }).then((r) => {
        if (r.isConfirmed) {
            const hoja = XLSX.utils.table_to_book(document.querySelector('.tabla-matriz'), { raw: true }).Sheets['Sheet1'];
            
            const col = { 'A':{bg:'FF10B981',font:'FFFFFFFF'}, 'R':{bg:'FFFBBF24',font:'FF000000'}, 'F':{bg:'FFEF4444',font:'FFFFFFFF'}, 'P':{bg:'FF3B82F6',font:'FFFFFFFF'}, 'D':{bg:'FF6B7280',font:'FFFFFFFF'}, 'C':{bg:'FF06B6D4',font:'FFFFFFFF'}, 'V':{bg:'FF8B5CF6',font:'FFFFFFFF'}, 'S':{bg:'FFCBD5E1',font:'FF000000'} };
            
            const rg = XLSX.utils.decode_range(hoja['!ref']);
            for (let R = rg.s.r; R <= rg.e.r; ++R) {
                for (let C = rg.s.c; C <= rg.e.c; ++C) {
                    const cell = hoja[XLSX.utils.encode_cell({c:C,r:R})]; if(!cell) continue;
                    let st = { alignment: { horizontal: "center", vertical: "center" }, border: { top:{style:"thin",color:{rgb:"FF555555"}}, bottom:{style:"thin",color:{rgb:"FF555555"}}, left:{style:"thin",color:{rgb:"FF555555"}}, right:{style:"thin",color:{rgb:"FF555555"}} }, font: {bold:true} };
                    if(R===0||R===1) { st.fill = {fgColor:{rgb:"FF0A0A0A"}}; st.font.color = {rgb:"FFFFFFFF"}; }
                    else if(C===0) { st.alignment.horizontal="left"; st.fill={fgColor:{rgb:"FF141414"}}; st.font.color={rgb:"FFFFFFFF"}; }
                    else if(col[cell.v]) { st.fill={fgColor:{rgb:col[cell.v].bg}}; st.font.color={rgb:col[cell.v].font}; }
                    cell.s = st;
                }
            }
            const w = [{wch:25}]; for(let i=1;i<=rg.e.c;i++) w.push({wch:4}); hoja['!cols'] = w;
            const lib = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(lib, hoja, "Matriz"); XLSX.writeFile(lib, `Matriz_${mes}.xlsx`);
        }
    });
}

async function cargarDatosMatriz() {
    try {
        const mesFormateado = document.getElementById('matriz-mes-anio').value;
        sessionStorage.setItem('filtro-matriz', mesFormateado);
        const res = await fetch(`/api/registros?mes=${mesFormateado}`, { headers: headersSeguros });
        const datos = await res.json();
        const resEmp = await fetch('/api/empleados', { headers: headersSeguros });
        dibujarMatriz(datos, (await resEmp.json()).filter(emp => emp.rol !== 'admin'));
    } catch (error) { console.error(error); }
}

function dibujarGrafico(puntual, retraso, falta, permiso, descanso, comision, vacaciones, sesantia) {
    const ctx = document.getElementById('graficoDona').getContext('2d');
    if (miGraficoDona) miGraficoDona.destroy();
    const total = puntual + retraso + falta + permiso + descanso + comision + vacaciones + sesantia;
    
    const dataColores = total === 0 ? ['#141414'] : ['#10B981', '#FBBF24', '#EF4444', '#3B82F6', '#6B7280', '#06B6D4', '#8B5CF6', '#cbd5e1'];
    
    const temaActual = localStorage.getItem('tema') || 'dark';
    const colorTexto = temaActual === 'light' ? '#111111' : '#ffffff'; 
    const estilosGenerales = getComputedStyle(document.body);
    const colorFondoTarjeta = estilosGenerales.getPropertyValue('--tarjeta').trim() || '#141414';

    miGraficoDona = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: total === 0 ? ['Sin datos'] : ['Puntual', 'Retraso', 'Falta', 'Permiso', 'Descanso', 'Comisión', 'Vacaciones', 'Sesantía'], datasets: [{ data: total === 0 ? [1] : [puntual, retraso, falta, permiso, descanso, comision, vacaciones, sesantia], backgroundColor: dataColores, borderWidth: 2, borderColor: colorFondoTarjeta, hoverOffset: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '75%', plugins: { legend: { position: 'bottom', labels: { color: colorTexto, font: { family: 'Poppins', size: 12 }, padding: 15 } } } }
    });
}

async function guardarAjustesTemporales() {
    const f = (val) => val ? parseInt(val.split(':')[0]) + (parseInt(val.split(':')[1]) / 60) : 0;
    const lim = { manana: f(document.getElementById('limite-manana').value), tarde: f(document.getElementById('limite-tarde').value), noche: f(document.getElementById('limite-noche').value), tolerancia: parseInt(document.getElementById('ajuste-tolerancia').value) };
    const reg = { diasLaborables: Array.from(document.querySelectorAll('.check-dia')).sort((a,b)=>a.dataset.idx-b.dataset.idx).map(c=>c.checked), feriados: ajustesEmpresaLocal.feriados, tiempoBloqueo: parseInt(document.getElementById('ajuste-bloqueo').value) || 5, branding: { nombreEmpresa: document.getElementById('nombre-empresa').value || 'Tenant', logoUrl: document.getElementById('logo-empresa').value || '', temaPorDefecto: document.getElementById('tema-defecto').value || 'dark' } };
    try {
        const r1 = await fetch('/api/ajustes', { method: 'POST', headers: headersSeguros, body: JSON.stringify(lim) });
        const r2 = await fetch('/api/ajustes/empresa', { method: 'POST', headers: headersSeguros, body: JSON.stringify(reg) });
        if (r1.ok && r2.ok) { ajustesEmpresaLocal.diasLaborables = reg.diasLaborables; ajustesEmpresaLocal.tiempoBloqueo = reg.tiempoBloqueo; aplicarBranding(reg.branding); Swal.fire('Guardado', 'Entorno actualizado', 'success'); cargarDatosMatriz(); } 
        else throw new Error('Error');
    } catch (e) { Swal.fire('Error', 'Fallo de sincronización', 'error'); }
}

async function cargarBrandingGlobal() {
    try { const res = await fetch('/api/ajustes/empresa', { headers: headersSeguros }); if (res.ok) { const aj = await res.json(); aplicarBranding(aj.branding); if (rolUsuario !== 'admin') document.getElementById('titulo-bienvenida').innerText = `${aj.branding.nombreEmpresa || 'Tenant'} | ID: ${sessionStorage.getItem('nombre')}`; } } catch (e) {}
}

async function cargarAjustes() {
    const res = await fetch('/api/ajustes', { headers: headersSeguros }); const lim = await res.json();
    const f = (d) => `${String(Math.floor(d)).padStart(2, '0')}:${String(Math.round((d - Math.floor(d)) * 60)).padStart(2, '0')}`;
    document.getElementById('limite-manana').value = f(lim.manana); document.getElementById('limite-tarde').value = f(lim.tarde); document.getElementById('limite-noche').value = f(lim.noche); document.getElementById('ajuste-tolerancia').value = lim.tolerancia || 15;
}

async function abrirSelectorManual(uid, nombre, fecha) {
    const { value: est } = await Swal.fire({ title: 'Ajuste Manual', text: `${nombre} | ${fecha}`, input: 'select', inputOptions: { 'PUNTUAL': 'A - Asistencia', 'RETRASO': 'R - Retraso', 'FALTA': 'F - Falta', 'PERMISO': 'P - Permiso', 'DESCANSO': 'D - Descanso', 'COMISION': 'C - Comisión', 'VACACIONES': 'V - Vacaciones', 'SESANTIA': 'S - Sesantía' }, showCancelButton: true });
    if (est && (await fetch('/api/registros/manual', { method: 'POST', headers: headersSeguros, body: JSON.stringify({ uid, nombre, fecha, estado: est }) })).ok) { Swal.fire('Actualizado', '', 'success'); cargarDatosMatriz(); }
} 

let ajustesEmpresaLocal = { diasLaborables: [], feriados: [] };

function aplicarBranding(branding) {
    if (!branding) return;
    const titulo = document.getElementById('titulo-bienvenida'); if (titulo) titulo.innerText = branding.nombreEmpresa || 'Tenant';
    const header = document.getElementById('contenedor-logo-top'); let imgLogo = document.getElementById('logo-sistema');
    if (branding.logoUrl) { if (!imgLogo) { imgLogo = document.createElement('img'); imgLogo.id = 'logo-sistema'; imgLogo.style.height = '24px'; imgLogo.style.marginRight = '10px'; imgLogo.style.borderRadius = '2px'; if (header) header.prepend(imgLogo); } imgLogo.src = branding.logoUrl; } else if (imgLogo) imgLogo.remove();
    if (branding.temaPorDefecto) { localStorage.setItem('tema', branding.temaPorDefecto); cambiarTema(true); }
}

async function cargarReglasEmpresa() {
    ajustesEmpresaLocal = await (await fetch('/api/ajustes/empresa', { headers: headersSeguros })).json();
    const dias = [{n:'Lun',i:1},{n:'Mar',i:2},{n:'Mié',i:3},{n:'Jue',i:4},{n:'Vie',i:5},{n:'Sáb',i:6},{n:'Dom',i:0}];
    document.getElementById('check-dias').innerHTML = dias.map(d => `<label style="display:flex; gap:8px;"><input type="checkbox" class="check-dia" data-idx="${d.i}" ${ajustesEmpresaLocal.diasLaborables[d.i] ? 'checked' : ''}> ${d.n}</label>`).join('');
    actualizarListaFeriadosVisual();
    if(document.getElementById('ajuste-bloqueo')) document.getElementById('ajuste-bloqueo').value = ajustesEmpresaLocal.tiempoBloqueo || 5;
    if(ajustesEmpresaLocal.branding) { document.getElementById('nombre-empresa').value = ajustesEmpresaLocal.branding.nombreEmpresa || ''; document.getElementById('logo-empresa').value = ajustesEmpresaLocal.branding.logoUrl || ''; document.getElementById('tema-defecto').value = ajustesEmpresaLocal.branding.temaPorDefecto || 'dark'; aplicarBranding(ajustesEmpresaLocal.branding); }
}

function actualizarListaFeriadosVisual() { document.getElementById('lista-feriados').innerHTML = ajustesEmpresaLocal.feriados.map(f => `<div class="badge-feriado"><span>${f}</span> <b onclick="eliminarFeriado('${f}')" style="cursor:pointer; color:#ff5252;">&times;</b></div>`).join(''); }
function agregarFeriado() { const f = document.getElementById('nuevo-feriado').value; if(f && !ajustesEmpresaLocal.feriados.includes(f)) { ajustesEmpresaLocal.feriados.push(f); actualizarListaFeriadosVisual(); } }
function eliminarFeriado(f) { ajustesEmpresaLocal.feriados = ajustesEmpresaLocal.feriados.filter(x => x !== f); actualizarListaFeriadosVisual(); }
async function autoCompletarFeriadosBO() { Swal.fire({title:'Buscando...', didOpen:()=>Swal.showLoading()}); try { const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${new Date().getFullYear()}/BO`); const data = await r.json(); let n = 0; data.forEach(d=>{if(!ajustesEmpresaLocal.feriados.includes(d.date)){ajustesEmpresaLocal.feriados.push(d.date);n++;}}); actualizarListaFeriadosVisual(); Swal.fire('Listo', `Se agregaron ${n} fechas`, 'success'); } catch(e){ Swal.fire('Error', 'Fallo de API', 'error'); } }

function procesarImagenLogo(event) {
    const a = event.target.files[0]; if (!a) return;
    if (a.size > 2 * 1024 * 1024) return Swal.fire('Error', 'Máximo 2MB', 'error');
    const r = new FileReader(); r.onload = (e) => { document.getElementById('logo-empresa').value = e.target.result; Swal.fire({toast:true, position:'top-end', showConfirmButton:false, timer:2000, icon:'success', title:'Logo pre-cargado'}); }; r.readAsDataURL(a);
}
function eliminarLogo() { document.getElementById('logo-empresa').value = ''; document.getElementById('input-archivo-logo').value = ''; const img = document.getElementById('logo-sistema'); if(img) img.remove(); }
function togglePasswordVisibility() { const i = document.getElementById('emp-pass'); const ic = document.getElementById('icono-pass'); if(i.type==='password'){i.type='text';ic.innerText='Ocultar';}else{i.type='password';ic.innerText='Ver';} }
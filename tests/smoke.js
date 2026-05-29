#!/usr/bin/env node
/*
 * Prueba de humo (headless) del CAMINO CRÍTICO de HHHA.
 * ----------------------------------------------------------------------------
 * Para qué: que NUNCA más se entregue un app.html donde "los datos no se ven".
 * Carga el app.html en un navegador simulado (jsdom), importa un respaldo real
 * de data/ (el mismo formato del botón "Importar"), y verifica lo esencial:
 *
 *   1. La lista de Equipos se ve COMPLETA (filas + filtros construidos).
 *   2. Se puede abrir la FICHA de un equipo.
 *   3. Los FILTROS funcionan (incluido filtrar por un valor numérico de columna,
 *      que era justo lo que rompía la tabla).
 *   4. El buscador rápido Ctrl+K devuelve resultados.
 *   5. El FOLIO se hereda del ciclo correctivo abierto (queda preseleccionado).
 *
 * Cómo correrla (SIEMPRE después de `python3 build_app.py`):
 *     node tests/smoke.js
 * Sale con código 1 si algo del camino crítico está roto.
 *
 * Requiere jsdom (solo para desarrollo): `npm i -D jsdom`. No afecta al app.html,
 * que sigue siendo un único archivo offline.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function loadJsdom(){
  for(const p of ['jsdom', '/tmp/node_modules/jsdom']){
    try { return require(p); } catch(e){ /* probar siguiente */ }
  }
  console.error('✗ Falta jsdom. Instálalo con:  npm i -D jsdom');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = loadJsdom();

const ROOT = path.resolve(__dirname, '..');
const APP = process.env.HHHA_APP || path.join(ROOT, 'app.html');
const BACKUP = process.env.HHHA_BACKUP || path.join(ROOT, 'data', '04_hhhadata20260528_6.json');
const STORAGE_KEY = 'hhha_v1_data';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail){ results.push({ name, ok: !!ok, detail: detail || '' }); }

(async () => {
  const html = fs.readFileSync(APP, 'utf8');
  const backupStr = fs.readFileSync(BACKUP, 'utf8');
  const backup = JSON.parse(backupStr);

  const pageErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push((e.detail && e.detail.stack) || e.message));
  vc.on('error', (...a) => { const s = a.join(' '); if(!s.includes('localStorage is not available')) pageErrors.push(s); });

  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/app.html', virtualConsole: vc });
  const w = dom.window;

  // Esperar a que el programa cargue (sus funciones globales estén definidas).
  for(let i = 0; i < 60 && typeof w.bootstrap !== 'function'; i++) await sleep(50);
  if(typeof w.bootstrap !== 'function'){ check('El programa carga', false, 'bootstrap no quedó definido'); return finish(); }

  // --- Importar un respaldo real de data/ (camino del botón "Importar") ---
  // Se deja en el almacenamiento y se re-arranca: load() lo lee y migra como en la importación.
  w.localStorage.setItem(STORAGE_KEY, backupStr);
  try { w.bootstrap(); } catch(e){ pageErrors.push('bootstrap import: ' + e.message); }
  await sleep(300);

  const totalEquipos = (backup.equipos || []).length;
  check('Respaldo de data/ con equipos', totalEquipos > 0, `${totalEquipos} equipos en el backup`);

  // --- 1) La lista de Equipos se ve COMPLETA ---
  try { w.navigate('equipos'); } catch(e){ pageErrors.push('navigate equipos: ' + e.message); }
  await sleep(300);
  const tbody = w.document.querySelector('table.eq-grid tbody');
  const filas = tbody ? tbody.querySelectorAll('tr').length : 0;
  const filtros = w.document.querySelectorAll('table.eq-grid thead .colf-btn').length;
  const counter = w.document.querySelector('.view .muted');
  const esperadas = Math.min(totalEquipos, 500);
  check('Equipos: la tabla se ve (no en blanco)', filas >= 100, `${filas} filas renderizadas`);
  check('Equipos: filas = mín(total,500)', filas === esperadas, `esperadas ${esperadas}, vistas ${filas}`);
  check('Equipos: filtros de columna construidos', filtros >= 5, `${filtros} filtros de columna`);
  check('Equipos: contador presente', !!(counter && /\d+\s+equipos/.test(counter.textContent)), counter ? counter.textContent.trim() : 'sin contador');

  // --- 3a) Filtro de columna multi-selección estilo Excel (uno, varios o todos) ---
  const colBtns = [...w.document.querySelectorAll('table.eq-grid thead .colf-btn')];
  let msOk = false, msDetalle = 'no había filtros de columna';
  if(colBtns.length){
    colBtns[0].dispatchEvent(new w.Event('click', { bubbles: true }));   // abre el checklist de la 1ª columna de lista
    await sleep(60);
    const pop = w.document.querySelector('.colf-pop');
    if(pop){
      const boxes = [...pop.querySelectorAll('.colf-item input[type=checkbox]')];
      const marcar = Math.min(2, boxes.length);
      for(let i = 0; i < marcar; i++){ boxes[i].checked = true; boxes[i].dispatchEvent(new w.Event('change', { bubbles: true })); }
      const aplicar = pop.querySelector('button.primary');
      aplicar.dispatchEvent(new w.Event('click', { bubbles: true }));
      await sleep(120);
      const fMs = w.document.querySelectorAll('table.eq-grid tbody tr').length;
      const btnAct = w.document.querySelector('table.eq-grid thead .colf-btn.activo');
      msOk = fMs > 0 && fMs <= 500 && !!btnAct;
      msDetalle = `marqué ${marcar} valor(es) → ${fMs} filas (botón: ${btnAct ? btnAct.textContent : '—'})`;
    } else { msDetalle = 'no se abrió el popup de filtro'; }
  }
  check('Equipos: filtro multi-selección (uno/varios)', msOk, msDetalle);

  // --- 3b) Búsqueda global filtra ---
  try { w.navigate('equipos'); } catch(e){}
  await sleep(250);
  const search = w.document.querySelector('.view input[type="search"]');
  const totalVista = w.document.querySelectorAll('table.eq-grid tbody tr').length;
  let terminoOk = true, detalleBusq = 'sin equipos para buscar';
  const primerInv = (backup.equipos[0] || {}).inv || '';
  if(search && primerInv){
    search.value = primerInv;
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(300);
    const fBusq = w.document.querySelectorAll('table.eq-grid tbody tr').length;
    terminoOk = fBusq > 0 && fBusq <= totalVista;
    detalleBusq = `buscar "${primerInv}" → ${fBusq} filas (de ${totalVista})`;
  }
  check('Equipos: búsqueda global filtra', terminoOk, detalleBusq);

  // --- 2) Abrir la FICHA de un equipo ---
  try { w.navigate('equipo', { inv: primerInv }); } catch(e){ pageErrors.push('navigate equipo: ' + e.message); }
  await sleep(250);
  const fichaTexto = w.document.querySelector('.view') ? w.document.querySelector('.view').textContent : '';
  check('Ficha de equipo abre y muestra el equipo', fichaTexto.includes(primerInv), `ficha de ${primerInv}`);

  // --- 4) Buscador rápido Ctrl+K ---
  let qsOk = false, qsDetalle = 'quickSearch no disponible';
  if(typeof w.quickSearch === 'function'){
    try {
      w.quickSearch();
      await sleep(80);
      const qsInput = w.document.querySelector('.quick-search-input');
      if(qsInput){
        qsInput.value = primerInv.slice(0, 4);
        qsInput.dispatchEvent(new w.Event('input', { bubbles: true }));
        await sleep(80);
        const qsRows = w.document.querySelectorAll('.qs-row').length;
        qsOk = qsRows > 0;
        qsDetalle = `"${primerInv.slice(0,4)}" → ${qsRows} resultados`;
      } else { qsDetalle = 'no se abrió el cuadro de búsqueda'; }
    } catch(e){ qsDetalle = 'excepción: ' + e.message; }
  }
  check('Ctrl+K: el buscador rápido devuelve resultados', qsOk, qsDetalle);

  // --- 5) El FOLIO se hereda del ciclo correctivo abierto ---
  const ciclosAb = (backup.ciclos || []).filter(c => c.estado === 'abierto');
  if(ciclosAb.length && typeof w.folioCicloControl === 'function'){
    const ctrl = w.folioCicloControl(ciclosAb);
    const ok = ctrl && ctrl.tagName === 'SELECT' && ctrl.value === ciclosAb[0].folio;
    check('Folio: se hereda del ciclo abierto (preseleccionado)', ok, `esperado "${ciclosAb[0].folio}", obtenido "${ctrl ? ctrl.value : '—'}"`);
  } else {
    check('Folio: se hereda del ciclo abierto (preseleccionado)', true, 'omitido (sin ciclos abiertos en el backup)');
  }

  // --- B) Recepción hereda el N° de envío (preseleccionado, no a mano) ---
  let invEnvio = null;
  for(const ev of (backup.eventos || [])){ if(String(ev.tipo||'').includes('Env') && ev.nEnvio){ invEnvio = ev.inv; break; } }
  if(invEnvio && typeof w.nEnvioRecepcionControl === 'function'){
    const ctrl = w.nEnvioRecepcionControl(invEnvio);
    const ok = ctrl && ctrl.tagName === 'SELECT' && !!ctrl.value;
    check('Recepción: hereda el N° de envío del Envío previo', ok, `${invEnvio} → "${ctrl ? ctrl.value : '—'}"`);
  } else {
    check('Recepción: hereda el N° de envío del Envío previo', true, 'omitido (sin envíos con N° en el backup)');
  }

  // --- E) Pendientes: columnas nuevas y estados con la nomenclatura del documento ---
  try { w.navigate('pendientes'); } catch(e){ pageErrors.push('navigate pendientes: ' + e.message); }
  await sleep(250);
  const headTxt = [...w.document.querySelectorAll('.view table thead th')].map(t => t.textContent).join('|');
  const tieneCols = ['Responsable','Recordatorio','Gestión'].every(c => headTxt.includes(c));
  check('Pendientes: columnas Responsable / Recordatorio / Gestión', tieneCols, headTxt ? headTxt.slice(0,140) : 'sin tabla');
  const opts = [...w.document.querySelectorAll('.view select option')].map(o => o.textContent);
  const estadosOk = ['Creado','Abierto','Cerrado'].every(s => opts.includes(s));
  check('Pendientes: estados del documento (Creado/Abierto/Cerrado)', estadosOk, ['Creado','Abierto','Cerrado'].filter(s => opts.includes(s)).join(', ') || '—');

  // --- Sin errores de JavaScript en pantalla durante el recorrido ---
  check('Sin errores de JavaScript en el recorrido', pageErrors.length === 0, pageErrors[0] ? pageErrors[0].split('\n')[0] : '');

  finish();

  function finish(){
    const fallos = results.filter(r => !r.ok);
    console.log('\n  PRUEBA DE HUMO · camino crítico HHHA');
    console.log('  app: ' + path.relative(ROOT, APP) + '  ·  backup: ' + path.relative(ROOT, BACKUP) + '\n');
    for(const r of results){
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
    }
    console.log('');
    if(fallos.length){
      console.error(`  ✗ FALLÓ: ${fallos.length} de ${results.length} chequeos. El camino crítico está roto.\n`);
      process.exit(1);
    }
    console.log(`  ✓ OK: ${results.length} chequeos pasaron. El camino crítico funciona.\n`);
    process.exit(0);
  }
})().catch(e => { console.error('Error inesperado en la prueba:', e); process.exit(1); });

// Navegación con mando de televisión (y con teclado, que es lo mismo).
//
// Un mando de Google TV no habla ningún protocolo especial: manda flechas,
// Enter y Atrás como un teclado. Lo que falta en una web pensada para ratón es
// que las flechas muevan el foco, porque el navegador sólo sabe recorrer el
// orden del documento con el tabulador, y ese orden no se parece a lo que se ve
// en pantalla: en una parrilla de portadas, "abajo" tiene que bajar una fila,
// no saltar al siguiente elemento del HTML.
//
// Esto no depende de cómo se abra la web. Metida en una app, en una PWA o en
// una pestaña normal, el problema y la solución son los mismos.

(() => {
  // ------------------------------------------------- modo television
  //
  // Se activa con ?tv=1 y se recuerda, para que baste con guardar la direccion
  // una vez en el navegador del televisor. Se apaga con ?tv=0.
  //
  // Se pide explicitamente en vez de adivinarlo por el tamaño de pantalla: un
  // monitor de escritorio grande da las mismas medidas que un televisor y
  // agrandarle todo seria molesto. Aqui quien lo sabe es quien lo abre.
  function aplicarModoTv() {
    const params = new URLSearchParams(location.search);
    const pedido = params.get('tv');
    if (pedido === '1') localStorage.setItem('noxis:tv', '1');
    if (pedido === '0') localStorage.removeItem('noxis:tv');
    if (localStorage.getItem('noxis:tv') === '1') document.documentElement.classList.add('tv');
  }
  aplicarModoTv();

  const FOCUSABLES = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const DIRECCIONES = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

  /** Visible de verdad: dentro del layout y con tamaño. */
  function esVisible(el) {
    if (el.hidden || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const est = getComputedStyle(el);
    return est.visibility !== 'hidden' && est.display !== 'none';
  }

  const candidatos = () => [...document.querySelectorAll(FOCUSABLES)].filter(esVisible);

  /**
   * El elemento más razonable en esa dirección.
   *
   * Se puntúa avance + desvío: entre dos que estén igual de lejos hacia abajo,
   * gana el que esté más alineado en horizontal. Sin ese peso, bajar desde una
   * portada saltaba a la esquina opuesta de la fila siguiente.
   */
  function siguiente(actual, direccion) {
    const r = actual.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    let mejor = null;
    let mejorPuntos = Infinity;

    for (const el of candidatos()) {
      if (el === actual || actual.contains(el)) continue;
      const b = el.getBoundingClientRect();
      const dx = (b.left + b.width / 2) - cx;
      const dy = (b.top + b.height / 2) - cy;

      let avance;
      let desvio;
      if (direccion === 'ArrowRight') { avance = dx; desvio = Math.abs(dy); }
      else if (direccion === 'ArrowLeft') { avance = -dx; desvio = Math.abs(dy); }
      else if (direccion === 'ArrowDown') { avance = dy; desvio = Math.abs(dx); }
      else { avance = -dy; desvio = Math.abs(dx); }

      // Un umbral pequeño y no cero: elementos casi a la misma altura no deben
      // contar como "arriba" o "abajo" por dos píxeles de diferencia.
      if (avance < 12) continue;

      const puntos = avance + desvio * 2;
      if (puntos < mejorPuntos) { mejorPuntos = puntos; mejor = el; }
    }
    return mejor;
  }

  function mover(direccion) {
    const actual = document.activeElement;
    const lista = candidatos();
    if (!lista.length) return false;

    // Sin nada enfocado —recién cargada la página, o tras cerrar algo— se
    // empieza por el principio en vez de no responder al primer botón.
    if (!actual || actual === document.body || !esVisible(actual)) {
      lista[0].focus();
      return true;
    }

    const destino = siguiente(actual, direccion);
    if (!destino) return false;

    destino.focus();
    // 'nearest' mueve lo justo: con 'center' la parrilla daba un salto entero
    // en cada paso y se perdía la referencia de dónde estabas.
    destino.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return true;
  }

  function escribiendo(el) {
    if (!el) return false;
    const etiqueta = el.tagName;
    if (etiqueta === 'TEXTAREA' || etiqueta === 'SELECT') return true;
    // Los campos de texto usan las flechas para mover el cursor; un desplegable
    // las usa para cambiar de opción. Ahí no se toca nada.
    return etiqueta === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes(el.type);
  }

  document.addEventListener('keydown', (e) => {
    if (!DIRECCIONES.includes(e.key)) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (escribiendo(document.activeElement)) return;

    // El reproductor ya usa las flechas para saltar en el vídeo y subir el
    // volumen, y esos atajos mandan mientras esté abierto.
    const reproductor = document.getElementById('playerOverlay');
    if (reproductor && !reproductor.hidden) return;

    if (mover(e.key)) e.preventDefault();
  });

  // Con mando no hay puntero: si al abrir no hay nada enfocado, la primera
  // flecha se gasta solo en colocar el foco. Se coloca de entrada sobre la
  // primera tarjeta, que es lo que se quiere tocar.
  if (document.documentElement.classList.contains('tv')) {
    const enfocarPrimero = () => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const tarjeta = document.querySelector('.card, .calendar-event');
      (tarjeta || candidatos()[0])?.focus();
    };
    // Un respiro: el catalogo se pinta despues de la primera peticion, asi que
    // enfocar de inmediato no encontraria ninguna tarjeta.
    window.addEventListener('load', () => setTimeout(enfocarPrimero, 900));
  }
})();

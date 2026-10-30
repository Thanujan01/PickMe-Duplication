import { MARKER_STYLE, type MapMarker } from './types';

/**
 * Builds the DOM node for a marker. Shared by any provider that supports
 * HTML markers (MapLibre today) so marker design lives in exactly one place.
 */
export function createMarkerElement(marker: MapMarker): HTMLElement {
  const style = MARKER_STYLE[marker.kind];

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;display:flex;align-items:center;gap:6px;cursor:pointer;';
  root.setAttribute('data-marker-kind', marker.kind);

  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:relative',
    `width:${style.size}px`,
    `height:${style.size}px`,
    'border-radius:9999px',
    `background:${style.fill}`,
    `border:2.5px solid ${style.ring}`,
    'box-shadow:0 2px 8px rgba(15,23,42,.35)',
    'display:flex;align-items:center;justify-content:center',
    'transition:transform 220ms ease-out',
  ].join(';');

  if (marker.pulse) {
    const halo = document.createElement('span');
    halo.style.cssText = [
      'position:absolute',
      'inset:-4px',
      'border-radius:9999px',
      `background:${style.fill}`,
      'opacity:.35',
      'animation:pulse-ring 1.8s cubic-bezier(.24,0,.38,1) infinite',
    ].join(';');
    dot.appendChild(halo);
  }

  if (style.directional && marker.heading != null && Number.isFinite(marker.heading)) {
    const arrow = document.createElement('span');
    arrow.style.cssText = [
      'position:absolute',
      'top:-9px',
      'left:50%',
      'width:0;height:0',
      'border-left:5px solid transparent',
      'border-right:5px solid transparent',
      `border-bottom:8px solid ${style.fill}`,
      'transform-origin:50% 17px',
      `transform:translateX(-50%) rotate(${marker.heading}deg)`,
      'transition:transform 260ms ease-out',
    ].join(';');
    arrow.setAttribute('data-marker-arrow', '');
    dot.appendChild(arrow);
  }

  root.appendChild(dot);

  if (marker.label) {
    const label = document.createElement('span');
    label.textContent = marker.label;
    label.style.cssText = [
      'white-space:nowrap',
      'font:600 11px/1 ui-sans-serif,system-ui,sans-serif',
      'padding:4px 7px',
      'border-radius:7px',
      'background:rgba(255,255,255,.95)',
      'color:#0f172a',
      'box-shadow:0 1px 5px rgba(15,23,42,.2)',
    ].join(';');
    root.appendChild(label);
  }

  if (marker.onClick) {
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      marker.onClick?.();
    });
  }

  return root;
}

/**
 * Cheap in-place refresh so a moving rider does not get a brand-new DOM node
 * (and therefore no flicker) on every GPS fix.
 */
export function updateMarkerElement(element: HTMLElement, marker: MapMarker): void {
  const arrow = element.querySelector<HTMLElement>('[data-marker-arrow]');
  if (arrow && marker.heading != null && Number.isFinite(marker.heading)) {
    arrow.style.transform = `translateX(-50%) rotate(${marker.heading}deg)`;
  }
  const label = element.querySelector<HTMLElement>('span:last-child');
  if (label && marker.label && label.textContent !== marker.label) {
    label.textContent = marker.label;
  }
}

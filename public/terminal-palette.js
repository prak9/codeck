const classic = {
  background: '#2e3436', foreground: '#d3d7cf', cursor: '#eeeeec', cursorAccent: '#2e3436',
  selectionBackground: '#e9542066', selectionForeground: '#ffffff',
  black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
  blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
  brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
  brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
};
const mac = {
  background: '#ffffff', foreground: '#24292f', cursor: '#0066cc', cursorAccent: '#ffffff',
  selectionBackground: '#b6d7ff', selectionForeground: '#182c49',
  black: '#24292f', red: '#b42318', green: '#176b32', yellow: '#806000',
  blue: '#005cc5', magenta: '#8250a0', cyan: '#006b75', white: '#626a73',
  brightBlack: '#57606a', brightRed: '#a32020', brightGreen: '#116329', brightYellow: '#735500',
  brightBlue: '#0550ae', brightMagenta: '#6639a6', brightCyan: '#005b66', brightWhite: '#414854',
};

export function bindTerminalPalette(terminal, root = document.documentElement, Observer = MutationObserver) {
  const update = () => {
    const light = root.dataset.terminalTheme === 'mac';
    terminal.options.theme = { ...(light ? mac : classic) };
    terminal.options.minimumContrastRatio = light ? 4.5 : 1;
  };
  update();
  const observer = new Observer(update);
  observer.observe(root, { attributes: true, attributeFilter: ['data-terminal-theme'] });
  return () => observer.disconnect();
}

// @ts-check
/* ShowMe sidebar webview. Receives snapshots from the extension and renders them. */
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  const icons = {
    prev: '<svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM6 8l7-6v12z"/></svg>',
    next: '<svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM10 8L3 14V2z"/></svg>',
    play: '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
    replay: '<svg viewBox="0 0 16 16"><path d="M8 3a5 5 0 1 1-4.9 6h1.6A3.5 3.5 0 1 0 8 4.5V7L4.5 3.75 8 .5z"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><path d="M3 3h10v10H3z"/></svg>',
  };

  // Desktop Linux uses Ctrl+Alt+arrows to switch workspaces, so ShowMe binds , and . there.
  const linux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  const keys = linux ? { prev: ',', next: '.' } : { prev: '←', next: '→' };

  /** @param {string} s */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  }

  /** Tiny Markdown subset: `code`, **bold**, *italic*, paragraphs. */
  function md(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function send(msg) {
    vscode.postMessage(msg);
  }

  const STATE_LABEL = {
    loading: 'Preparing…',
    playing: 'Playing',
    paused: 'Paused',
    waiting: 'Waiting for you',
    finished: 'Finished',
    idle: 'Stopped',
  };

  function render(s) {
    if (!s || (!s.title && s.state === 'idle' && !(s.issues && s.issues.length))) {
      app.innerHTML = `
        <div class="empty">
          <h2>No tour playing</h2>
          <p>Ask your agent something like:</p>
          <div class="quote">“Show me how the login flow works.”</div>
          <div class="stack">
            <button class="primary" data-cmd="playTour">${icons.play} Play a saved tour…</button>
            <button data-cmd="playDemo">Play the demo tour</button>
            <button data-cmd="installSkill">Install the agent skill</button>
          </div>
        </div>`;
      return;
    }

    const step = s.steps[s.index];
    const active = s.state !== 'idle';
    const playing = s.state === 'playing' || s.state === 'loading';
    const issues = (s.issues || []).filter((i) => !i.step);

    const controls = active
      ? `<div class="controls">
          <button data-cmd="previous" title="Previous step (Ctrl+Alt+${keys.prev})" ${s.index === 0 ? 'disabled' : ''}>${icons.prev}</button>
          <button class="primary" data-cmd="togglePause" title="Pause / resume (Ctrl+Alt+Space)">${
            playing ? icons.pause + ' Pause' : s.state === 'finished' ? icons.replay + ' Again' : icons.play + (s.state === 'waiting' ? ' Next' : ' Resume')
          }</button>
          <button data-cmd="next" title="Next step (Ctrl+Alt+${keys.next})">${icons.next}</button>
          <button data-cmd="replay" title="Replay this step">${icons.replay}</button>
          <button data-cmd="stop" title="Stop the tour">${icons.stop}</button>
        </div>`
      : `<div class="controls"><button class="primary" data-cmd="replayTour">${icons.play} Play again</button>
         <button data-cmd="playTour" title="Pick another tour">Other…</button></div>`;

    const caption =
      active && step
        ? `<div class="caption">
            <div class="step-title">${esc(step.title)}</div>
            ${md(step.narration)}
            ${step.location ? `<div class="where">${esc(step.location)}</div>` : ''}
          </div>`
        : '';

    const issueBox = issues.length
      ? `<div class="issues"><strong>Tour problems</strong><ul>${issues.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul></div>`
      : '';

    const steps = s.steps
      .map((st, i) => {
        const cls = [i === s.index && active ? 'current' : '', i < s.index && active ? 'done' : ''].join(' ');
        return `<li class="${cls}" data-goto="${i}" title="Jump to step ${i + 1}">
          <span class="num">${i + 1}</span><span>${esc(st.title)}</span>
          ${st.location ? `<span class="loc">${esc(st.location)}</span>` : ''}
          ${st.issue ? `<span class="issue">⚠ ${esc(st.issue)}</span>` : ''}
        </li>`;
      })
      .join('');

    app.innerHTML = `
      <h2>${esc(s.title || 'Tour')}</h2>
      <div class="meta state-${s.state}">
        <span><span class="state-dot"></span>${STATE_LABEL[s.state] || s.state}${s.total ? ` · step ${s.index + 1} of ${s.total}` : ''}</span>
        <span>🔊 ${esc(s.voice)}</span>
      </div>
      ${controls}
      ${issueBox}
      ${caption}
      <div class="section-label">Steps</div>
      <ol class="steps">${steps}</ol>
      <div class="hint"><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd> pause · <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>${keys.prev}</kbd>/<kbd>${keys.next}</kbd> step</div>`;

    const current = app.querySelector('li.current');
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  app.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const cmd = target.closest('[data-cmd]');
    if (cmd) {
      send({ type: 'command', command: cmd.getAttribute('data-cmd') });
      return;
    }
    const li = target.closest('[data-goto]');
    if (li) send({ type: 'goto', index: Number(li.getAttribute('data-goto')) });
  });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') render(event.data.snapshot);
  });

  render(undefined);
  send({ type: 'ready' });
})();

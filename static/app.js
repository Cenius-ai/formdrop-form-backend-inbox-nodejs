'use strict';

/* Formdrop client enhancements: password toggle, demo fill, copy buttons,
 * one-render busy state on submit, and the ⌘K command palette.
 * Everything here is progressive — every action still works without JS. */

(function () {
  function ensureStatusRegion() {
    let region = document.getElementById('client-status');
    if (region) return region;
    region = document.createElement('p');
    region.id = 'client-status';
    region.className = 'sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
    return region;
  }

  function announce(message) {
    const region = ensureStatusRegion();
    region.textContent = message;
  }

  function setupPasswordToggle() {
    document.querySelectorAll('[data-password-toggle]').forEach(function (button) {
      const targetId = button.getAttribute('aria-controls');
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target) return;
      button.addEventListener('click', function () {
        const revealed = target.type === 'text';
        target.type = revealed ? 'password' : 'text';
        button.textContent = revealed ? 'Show' : 'Hide';
        button.setAttribute('aria-pressed', revealed ? 'false' : 'true');
        target.focus();
      });
    });
  }

  function setupDemoFill() {
    document.querySelectorAll('[data-fill-demo]').forEach(function (button) {
      button.addEventListener('click', function () {
        const email = document.querySelector('input[name="email"]');
        const password = document.querySelector('input[name="password"]');
        const submit = button.closest('section') && button.closest('section').querySelector('form button[type="submit"]');
        if (email) email.value = button.getAttribute('data-demo-email') || '';
        if (password) password.value = button.getAttribute('data-demo-password') || '';
        if (submit) submit.focus();
        else if (password) password.focus();
        announce('Demo credentials filled in. Press Enter to sign in.');
      });
    });
  }

  function legacyCopy(value) {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.className = 'sr-only';
    document.body.appendChild(field);
    field.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(field);
    return copied;
  }

  function setupCopyButtons() {
    document.querySelectorAll('[data-copy]').forEach(function (button) {
      const original = button.textContent;
      button.addEventListener('click', function () {
        const value = button.getAttribute('data-copy') || '';
        const finish = function (copied) {
          button.textContent = copied ? 'Copied' : 'Copy failed';
          announce(copied ? 'Endpoint URL copied to the clipboard.' : 'Could not copy — select the URL text instead.');
          window.setTimeout(function () {
            button.textContent = original;
          }, 2200);
        };
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(value).then(
            function () {
              finish(true);
            },
            function () {
              finish(legacyCopy(value));
            },
          );
          return;
        }
        finish(legacyCopy(value));
      });
    });
  }

  function setupBusyState() {
    document.querySelectorAll('form[data-busy-on-submit]').forEach(function (form) {
      const button = form.querySelector('button[type="submit"]');
      if (button && !button.hasAttribute('data-restore-label')) {
        button.setAttribute('data-restore-label', button.textContent.trim());
      }
      form.addEventListener('submit', function (event) {
        if (form.dataset.submitting === '1') {
          event.preventDefault();
          return;
        }
        form.dataset.submitting = '1';
        if (!button) return;
        const label = button.getAttribute('data-busy-label') || 'Working…';
        window.setTimeout(function () {
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          button.textContent = label;
        }, 0);
      });
    });

    window.addEventListener('pageshow', function () {
      document.querySelectorAll('form[data-busy-on-submit]').forEach(function (form) {
        delete form.dataset.submitting;
        const button = form.querySelector('button[type="submit"]');
        if (!button) return;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        const restore = button.getAttribute('data-restore-label');
        if (restore) button.textContent = restore;
      });
    });
  }

  function setupPalette() {
    const dialog = document.getElementById('command-palette');
    const input = document.getElementById('palette-input');
    const list = document.getElementById('palette-list');
    const opener = document.querySelector('[data-palette-open]');
    if (!dialog || !input || !list) return;

    const entries = [];
    const seen = Object.create(null);
    function addEntry(label, href, kind) {
      if (!href || seen[href]) return;
      seen[href] = true;
      entries.push({ label: label, href: href, kind: kind });
    }

    addEntry('Your form endpoints', '/app', 'Page');
    document.querySelectorAll('a[data-palette]').forEach(function (anchor) {
      const label = anchor.getAttribute('data-palette') || anchor.textContent.trim();
      const kind = anchor.closest('.endpoint-row') ? 'Endpoint' : 'Form';
      addEntry(label, anchor.getAttribute('href'), kind);
    });

    let activeIndex = 0;

    function matches(query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return entries;
      return entries.filter(function (entry) {
        return entry.label.toLowerCase().indexOf(needle) !== -1;
      });
    }

    function render() {
      const results = matches(input.value);
      list.textContent = '';
      if (results.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'palette-empty';
        empty.textContent = 'No pages match that search.';
        list.appendChild(empty);
        activeIndex = -1;
        return;
      }
      if (activeIndex >= results.length) activeIndex = 0;
      if (activeIndex < 0) activeIndex = 0;
      results.forEach(function (entry, index) {
        const item = document.createElement('li');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
        const anchor = document.createElement('a');
        anchor.href = entry.href;
        anchor.className = index === activeIndex ? 'is-active' : '';
        const kind = document.createElement('span');
        kind.className = 'palette-kind';
        kind.textContent = entry.kind;
        anchor.appendChild(kind);
        anchor.appendChild(document.createTextNode(entry.label));
        item.appendChild(anchor);
        list.appendChild(item);
      });
    }

    function open() {
      activeIndex = 0;
      input.value = '';
      render();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', 'open');
      input.focus();
    }

    function close() {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }

    function currentResults() {
      return matches(input.value);
    }

    if (opener) opener.addEventListener('click', open);
    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        if (dialog.open) close();
        else open();
      }
    });
    input.addEventListener('input', function () {
      activeIndex = 0;
      render();
    });
    input.addEventListener('keydown', function (event) {
      const results = currentResults();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!results.length) return;
        activeIndex = (activeIndex + 1) % results.length;
        render();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!results.length) return;
        activeIndex = (activeIndex - 1 + results.length) % results.length;
        render();
      } else if (event.key === 'Enter') {
        if (!results.length) return;
        event.preventDefault();
        window.location.assign(results[Math.max(activeIndex, 0)].href);
      }
    });
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) close();
    });
  }

  function start() {
    setupPasswordToggle();
    setupDemoFill();
    setupCopyButtons();
    setupBusyState();
    setupPalette();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

import type { On } from 'claude-code';
import { RouletteController, serverUrl } from './controller';
import { paneView } from './view';

const PANE = 'claude-roulette';

export function register(on: On): void {
  let controller: RouletteController | undefined;

  on('session.start', async ($, e, next) => {
    if (e.isInteractive && (e.surface === 'terminal' || e.surface === 'desktop')) {
      try {
        const url = serverUrl(await $.env.get('ROULETTE_URL'));
        const created = new RouletteController({
          fetch: (address, init) => $.http.fetch(address, init),
          storeGet: key => $.store.get(key),
          storeSet: (key, value) => $.store.set(key, value),
          now: () => $.clock.now(),
          every: (ms, fn) => $.clock.every(ms, fn),
          invalidate: () => $.ui.invalidate('ui.render'),
          status: text => $.ui.status(text),
          toast: text => $.ui.toast(text),
          open: focus => $.ui.open({ id: PANE, title: 'Roulette', rows: 25, ...(focus ? { focus: true } : {}) }),
          close: () => $.ui.close({ id: PANE }),
        }, url);
        await created.load();
        controller = created;
        await $.command.register({ name: 'roulette', description: 'Meet another human while Claude works', immediate: true });
      } catch {
        $.ui.log('Roulette could not initialize. Check ROULETTE_URL and your Claude Mods version.');
      }
    }
    return next(e);
  });

  on('command.run', { command: 'roulette' }, async ($, e, next) => {
    if (!controller) return next(e);
    await controller.open();
    return {};
  });

  on('turn.start', ($, e, next) => {
    controller?.setBusy(e.turnId);
    return next(e);
  });

  on('turn.complete', ($, e, next) => {
    controller?.complete(e.turnId, e.agentId);
    return next(e);
  });

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE || !controller || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e);
    const ui = $.ui.resolve(e);
    return paneView(ui, controller, e.props.bodyColumns, e.props.scroll.bodyRows);
  });

  on('ui.close', { id: PANE }, ($, e, next) => {
    controller?.closed();
    return next(e);
  });

  on('classic.SessionEnd', ($, e, next) => {
    void controller?.stop();
    return next(e);
  });
}

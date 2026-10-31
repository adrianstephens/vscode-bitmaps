// The menu's items used from a page test without the pointer, so that a test is of what an item does and not of where the menu puts it.
// The page's own modules (as it has loaded them) give the current mode, whose items (its menu, and the View item's) are found by their
// ids (or, for one that has none, by how its caption starts), a strip at a time, and are chosen, turned or hovered as the menu would. The tools' and transforms' own items are not the mode's:
// their operations are mode.run's (see run), and the rest is the pointer's (cascadehost.js).

type Page = {evaluate: (fn: string) => Promise<any>};

// In the page (as text, so that it is not compiled for node): the item at the end of the ids, from the mode's menu and View item, and
// what is done with it
const inPage = `async (ids, what, arg) => {
	const {mode} = await import('/out/webview/modes.js');
	let items = [...mode.menu(), {id: 'view', children: () => mode.viewItems()}], item;
	for (const id of ids) {
		item = items.find(i => i.id === id) ?? items.find(i => !i.id && i.caption?.().startsWith(id));
		if (!item)
			throw new Error('no ' + id + ' in the menu, among ' + items.map(i => i.id ?? '-').join(' '));
		items = item.children?.() ?? [];
	}
	switch (what) {
		case 'ids':		return items.map(i => i.id ?? '');
		case 'faces':	return items.map(i => i.face());
		case 'active':	return !!item.active?.();
		case 'hover':	return item.hover?.(arg);
		case 'wheel':	return item.wheel(arg);
		case 'select':
			if (!item.select)
				throw new Error(ids.join('/') + ' cannot be chosen');
			return item.select();
	}
}`;

const call = (page: Page, ids: string[], what: string, arg?: unknown) =>
	page.evaluate(`(${inPage})(${JSON.stringify(ids)}, ${JSON.stringify(what)}, ${JSON.stringify(arg ?? null)})` as any);

/** The item chosen, as a click on it would. */
export const choose	= (page: Page, ids: string[]) => call(page, ids, 'select');
/** The ids of the items in the strip that comes out of the item (of the menu itself, with none). */
export const ids	= (page: Page, path: string[] = []): Promise<string[]> => call(page, path, 'ids');
/** Their faces, as HTML. */
export const faces	= (page: Page, path: string[] = []): Promise<string[]> => call(page, path, 'faces');
/** Whether the item is marked, as the one that is current. */
export const active	= (page: Page, path: string[]): Promise<boolean> => call(page, path, 'active');
/** The pointer come to rest on the item, or gone from it. */
export const hover	= (page: Page, path: string[], on: boolean) => call(page, path, 'hover', on);
/** The wheel turned over the item, by steps (up is positive). */
export const turn	= (page: Page, path: string[], steps: number) => call(page, path, 'wheel', steps);
/** An operation of the tools or transforms, as the extension's commands run it. */
export const run	= (page: Page, op: string) => page.evaluate(`(async () => (await import('/out/webview/modes.js')).mode.run(${JSON.stringify(op)}))()` as any);

# SvelteKit remote functions

How to define and call remote functions in these apps. `remoteFunctions` and
`compilerOptions.experimental.async` are on in every app's `vite.config.ts`.

## Rules

1. **Use the kit wrappers.** `Remote.Query`, `Remote.Cmd` and `Remote.Form` from
   `@zeyolabs/kit/server/remote-functions`, never `query`/`command`/`form` from `$app/server`
   directly. They take an optional zod schema first and the handler second, and route every failure
   to the right channel (see [Errors](#errors)).
2. **Remote modules hold only remote functions.** A file with `remote` in its name
   (`x.remote.ts`) may export nothing else; shared helpers go in another file. They live in
   `src/lib/remote/` and are called straight from components.
3. **Never `await` a query in `<script>`.** Read query results in markup: inline
   (`{await getThingRQ()}`) or in a declaration tag (`{const thing = $derived(await getThingRQ())}`).
   Plain values a query needs (a URL param, a prop) can still be worked out in `<script>`.
4. **Every awaited query sits in a `<Boundary>`** (`@zeyolabs/ui/boundary/Boundary.svelte`) with a
   skeleton `pending` snippet; its `failed` card reports the error and offers "Try again". For a
   different fallback, write a raw `<svelte:boundary onerror={reportBoundaryError}>` with your own
   snippets. A boundary renders `pending` on the server and loads the data in the browser.
5. **No remote function inside `$effect`.** Calling, `.refresh()`ing or `.set()`ing one writes its
   own reactive state, so the effect re-runs until Svelte throws `effect_update_depth_exceeded`. No
   `setInterval` polling in an effect either.
6. **Commands run from event handlers.** `await someCmd()` belongs in a click or submit handler,
   never in render code.
7. **Page-load work happens on the server.** Clearing a cookie, fulfilling an order or marking
   something seen is a `+server.ts` handler that does the work and redirects, or the handler of the
   `Form`/`Cmd` that caused it. A client-side "on load, call X" is the wrong shape.
8. **Public, indexable pages load on the server.** A page a search engine should see gets a
   `+page.server.ts` whose `load` calls the same remote query and renders from `data`, so the content
   is in the HTML and a missing item is a real 404 (a boundary would catch it and answer 200).
   Personal and private pages use rule 4.
9. **Forms render through `Form`** and the fields from `@zeyolabs/ui/form`. Every control,
   including hidden inputs and submit buttons, comes from `form.fields.<name>.as(...)`; hand-written
   `name=` attributes are rejected.

```svelte
<!-- wrong: awaited in <script>, and a remote call in an effect -->
<script lang="ts">
	const order = $derived(await getOrderRQ(id));
	$effect(() => {
		if (order) clearBasketCmd();
	});
</script>

<!-- right -->
<Boundary message="Could not load this order.">
	{const order = $derived(await getOrderRQ(id))}
	<Text>{order.number}</Text>

	{#snippet pending()}
		<SkeletonText lines={2} />
	{/snippet}
</Boundary>
```

```typescript
// +page.server.ts for a public page: a missing product is a real 404
export async function load({ params }) {
	return { page: await getProductRQ(params.slug) };
}
```

## Defining

```typescript
// src/lib/remote/things.remote.ts
import { Remote } from '@zeyolabs/kit/server/remote-functions';
import { FormResult } from '@zeyolabs/kit/utils/form';
import { z } from 'zod';

export const getThingsRQ = Remote.Query(async () => listThings());
export const getThingRQ = Remote.Query(z.string(), async (id) => findThing(id));
export const archiveThingCmd = Remote.Cmd(z.string(), async (id) => archiveThing(id));
export const updateThingForm = Remote.Form(UpdateThingSchema, async (input) => {
	await updateThing(input);
	return FormResult.ok('Saved');
});
```

App remote functions end in `RQ`, `Cmd` or `Form`.

**Prefer `Form` over `Cmd`.** A mutation that takes user input is a `Form`: schema validation,
pending state, toasts and `<Button form={...}>` wiring come free. A `Cmd` is for input-free actions
(toggle, delete by id). A parameterized read is a `Query`, never a `Cmd`.

Queries are cached by function and serialized arguments, so the same call anywhere shares one
request. Any component may await its own query; there is no need to hoist it to the page.

## Fetching

Use `await` in markup. No `{#await}` blocks and no `{@const}`: use declaration tags
(`{const}`/`{let}`).

1. **Inline `await`**, preferred. Sibling awaits run concurrently.

   ```svelte
   <Text>{await getThingsRQ()}</Text>
   <Text>{await getOrdersRQ(user.id)}</Text>
   ```

2. **`$derived(await ...)` in a declaration tag** to name, reuse or destructure a result. It stays
   reactive to refreshes and argument changes. Several values load in parallel with one
   `Promise.all`; separate declaration tags, or a declaration tag next to inline awaits, waterfall.

   ```svelte
   {const [things, orders] = $derived(await Promise.all([getThingsRQ(), getOrdersRQ(user.id)]))}
   <Text>{things.length} things, {orders.length} orders</Text>
   ```

3. **A one-off fetch** (on click, on selection) is `await getThingRQ(id)` in the handler.

## Refreshing

Prefer the server, from the handler that mutated, so the new data rides the same response:

```typescript
export const renameThingForm = Remote.Form(RenameSchema, async (input) => {
	const thing = await renameThing(input);
	getThingRQ(thing.id).set(thing); // the handler has the value
	void getThingsRQ().refresh(); // it only knows the instance
	return FormResult.ok('Renamed');
});
```

When the query is keyed on arguments only the client knows (a live filter), the client names the
instances with `submit().updates(...)` and the handler opts in with `requested(query, limit)` from
`$app/server`. `limit` is required: the list comes from the client.

```typescript
await requested(getPostsRQ, 1).refreshAll();
```

Last resort, a separate round trip: call the query with the same arguments and `.refresh()` it on
the client.

## Errors

Throw `Error404`/`Error400`/... from `@zeyolabs/kit/utils/errors` for an expected failure, or a `Fail`
from `@zeyolabs/kit/server/result` for a soft business failure. Anything else is logged and hidden behind a generic message.

- `Query` and `Cmd` rethrow as an HTTP error. A query's error reaches the nearest boundary's
  `failed` snippet; a command's rejects the `await` at the call site.
- `Form` never throws a failure: it becomes an inline `FormResult.err`. A `redirect()` from the
  handler still navigates.

## Reference

- [Await expressions](https://svelte.dev/docs/svelte/await-expressions)
- [Declaration tags](https://svelte.dev/docs/svelte/declaration-tags)
- [Remote functions](https://svelte.dev/docs/kit/remote-functions)

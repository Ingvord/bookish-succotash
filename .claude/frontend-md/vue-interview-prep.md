# Vue Interview Prep: From Webix / ExtJS / Angular to Vue 3

Target role: Staff Frontend Engineer (Visable). Stack: Vue.js, Jest/Cypress, build tooling (Gulp, Vite, Webpack, Rollup), Nuxt/SSR bonus, AI-assisted development, multi-brand design system.

**Versions you are targeting (June 2026).** Vue stable is **3.5.x**, with the Composition API and `<script setup>` as the default authoring style. Vue **3.6** is in beta and introduces **Vapor mode**, a compile-time strategy that drops the virtual DOM for less memory and faster updates, opt-in per component and compatible with the Composition API. **Vite 8** is the standard build tool. **Pinia** is the state library, **Vitest** the test runner, **Nuxt 4** the SSR meta-framework. Everything below uses current idioms only. There is no Vue 2 or pre-3.5 material here.

---

## 1. The core mental model shift

The one idea that reframes everything you already know:

**Webix and ExtJS are config-driven and imperative. You construct widgets from JSON config, then mutate those instances by reference or id (`$$("grid").setValue(...)`, `vm.set('count', ...)`). Vue is declarative and reactive. You describe the UI as a pure function of state, and the framework re-renders when state changes. You never touch the widget instance or the DOM directly.**

What disappears when you move to Vue:

- No `$$("id")` lookups, no `getValue`/`setValue`. Reactive `ref`s replace manual reads and writes.
- No global widget registry. Components are values you import and mount as tags.
- No "rebuild this part of the layout" calls. You mutate state, Vue diffs and patches.

The habit to build: stop reaching for the instance. Change the data and let it render.

Angular maps closely to Vue. Both are declarative, component-based, and reactive, with near 1:1 template directives. Your Angular intuition transfers directly. The real gap is recent Vue idioms and current tooling, not concepts.

---

## 2. Concept mapping table

| Concept | Webix | ExtJS | Angular | Vue 3 |
|---|---|---|---|---|
| Define a component | `webix.ui({...})` / `webix.protoUI` | `Ext.define('Cls', {...})` | `@Component` class | `.vue` SFC / `defineComponent` |
| Mount / instantiate | auto from config tree | `Ext.create` / `xtype` | selector in template | `<MyComp />` tag |
| Template | `template` string | `tpl` / `XTemplate` | HTML + directives | `<template>` + directives |
| Reactive local state | DataCollection + events | `viewModel.data` | `signal()` | `ref()` / `reactive()` |
| Two-way binding | `.bind()`, events | `bind: { value: '{x}' }` | `[(ngModel)]` | `v-model` |
| One-way attr bind | `template:"#name#"` | `bind: {...}` | `[prop]="x"` | `:prop="x"` |
| Event handling | `click:` / `on:{}` | `listeners` / `handler` | `(click)="f()"` | `@click="f()"` |
| List rendering | `view:"list"` + data | `Ext.view.View` + Store | `@for` | `v-for` |
| Conditional render | `hidden` / `show()` | `hidden` config | `@if` | `v-if` / `v-show` |
| Derived value | manual | ViewModel `formulas` | `computed()` | `computed()` |
| Side effect on change | event handlers | `bind` + listeners | `effect()` / RxJS | `watch` / `watchEffect` |
| Lifecycle | `on:onAfterRender` | `initComponent` | `ngOnInit` | `onMounted` / `onUnmounted` |
| Cross-tree share | global `webix` | singletons | DI / `@Injectable` | `provide` / `inject`, composables |
| Reuse logic | mixins | mixins / plugins | services | composables (`useXxx`) |
| App state store | DataCollection | Stores | NgRx / services | Pinia |
| Content projection | layout config | items / docked | `<ng-content>` | `<slot>` |

---

## 3. Code comparison: a reactive counter

Shows the spectrum from imperative (Webix) to reactive declarative (Vue).

### Webix (imperative, mutate by id)
```js
webix.ui({
  rows: [
    { view: "label", id: "lbl", label: "Count: 0" },
    { view: "button", value: "Increment", click: function () {
      const n = ($$("lbl").config.count = ($$("lbl").config.count || 0) + 1);
      $$("lbl").define("label", "Count: " + n);
      $$("lbl").refresh();
    }}
  ]
});
```

### ExtJS (ViewModel binding)
```js
Ext.define('MyCounter', {
  extend: 'Ext.panel.Panel',
  viewModel: { data: { count: 0 } },
  items: [
    { xtype: 'displayfield', bind: { value: 'Count: {count}' } },
    { xtype: 'button', text: 'Increment', handler: function () {
      const vm = this.lookupViewModel();
      vm.set('count', vm.get('count') + 1);
    }}
  ]
});
```

### Angular (signals)
```ts
@Component({
  selector: 'app-counter',
  template: `
    <p>Count: {{ count() }}</p>
    <button (click)="count.set(count() + 1)">Increment</button>
  `
})
export class CounterComponent {
  count = signal(0);
}
```

### Vue 3 (`<script setup>`)
```vue
<script setup>
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <p>Count: {{ count }}</p>
  <button @click="count++">Increment</button>
</template>
```
You mutate `count`, Vue re-renders. `count.value` is auto-unwrapped in the template, so you write `count` in markup. Angular's `signal()` and Vue's `ref()` are the same idea: `count()` to read in Angular, `count.value` to read in Vue script.

---

## 4. Code comparison: filtered list

A likely live-coding shape.

### Vue 3
```vue
<script setup>
import { ref, computed } from 'vue'

const query = ref('')
const items = ref(['apple', 'banana', 'cherry', 'avocado'])

const filtered = computed(() =>
  items.value.filter(i => i.toLowerCase().includes(query.value.toLowerCase()))
)
</script>

<template>
  <input v-model="query" placeholder="Filter" />
  <ul>
    <li v-for="item in filtered" :key="item">{{ item }}</li>
  </ul>
</template>
```

### Angular
```ts
@Component({
  template: `
    <input [(ngModel)]="query" />
    <ul>
      @for (item of filtered(); track item) {
        <li>{{ item }}</li>
      }
    </ul>
  `
})
export class ListComponent {
  query = signal('');
  items = signal(['apple', 'banana', 'cherry', 'avocado']);
  filtered = computed(() => this.items().filter(i => i.includes(this.query())));
}
```

### ExtJS
```js
Ext.create('Ext.view.View', {
  store: { data: [{ name: 'apple' }, { name: 'banana' }] },
  tpl: '<tpl for="."><div class="row">{name}</div></tpl>',
  itemSelector: 'div.row'
});
// store.filterBy(rec => rec.get('name').includes(query));
```

### Webix
```js
webix.ui({
  rows: [
    { view: "text", id: "q", on: {
      onTimedKeyPress: () => $$("lst").filter("#value#", $$("q").getValue())
    }},
    { view: "list", id: "lst", template: "#value#",
      data: ["apple", "banana", "cherry", "avocado"] }
  ]
});
```

The Vue habit to internalize: derive the view from state with `computed`, do not imperatively poke a widget.

---

## 5. Vue cookbook: runnable mini-apps

This is the section an interviewer probes hardest, because it separates people who have used Vue from people who understand its reactivity model. Each item states the concept in prose first, then gives a complete `.vue` component you can drop into the Vite scaffold from section 7 and run. Read the prose, then trace the code against it.

### 5.1 `ref` vs `reactive`, and why destructuring breaks reactivity

Reach for `ref` by default, for both primitives and objects. It behaves predictably everywhere: you read and write `.value` in script, and Vue auto-unwraps it in the template. `reactive` exists for objects only, and it carries a sharp edge that shows up constantly in interviews. A `reactive` object is a Proxy, and reactivity lives on the proxy, not on the values inside it. The moment you destructure it, you copy the current values out and sever the link to the proxy, so those copies never update again. `toRefs` fixes this by wrapping each property in its own ref that stays connected to the source.

The practical rule: default to `ref`, and if you do use `reactive`, never destructure it without `toRefs`.

```vue
<script setup>
import { reactive, toRefs, ref } from 'vue'

const user = reactive({ name: 'Ada', age: 36 })
const { name } = user            // BROKEN: 'name' is a plain string snapshot
const { age } = toRefs(user)     // OK: 'age' stays reactive

const counter = ref(0)           // simplest, always reactive
</script>

<template>
  <p>Broken snapshot: {{ name }}</p>
  <p>Reactive via toRefs: {{ age }}</p>
  <button @click="user.age++">Age + (only the toRefs binding updates)</button>
  <hr />
  <p>Counter (ref): {{ counter }}</p>
  <button @click="counter++">Counter +</button>
</template>
```

In the running app, clicking the button mutates `user.age`, but only the `toRefs` binding re-renders. The plain destructured `name` stays frozen at its first value. That one behavior is the whole lesson.

### 5.2 computed vs method vs watch

These three look similar and do different jobs, and confusing them is the most common Vue smell. A `computed` derives a value from other reactive state and caches the result, recomputing only when a dependency changes. It must be pure, with no side effects. A plain method re-runs on every render whether or not its inputs changed, so it fits event handlers and is wrong for derived display values. A `watch` (or `watchEffect`) exists for side effects in response to change: persisting to storage, firing a request, logging. You never use a watch to produce a value you could have computed.

The decision is mechanical: derive a value with `computed`, react to a change with a side effect using `watch`, respond to a user action with a method.

```vue
<script setup>
import { ref, computed, watch } from 'vue'

const price = ref(100)
const qty = ref(2)

const total = computed(() => price.value * qty.value)   // cached, recomputes on dep change
const totalMethod = () => price.value * qty.value        // runs on every render

watch(total, (newTotal) => {                             // side effect on change
  localStorage.setItem('lastTotal', String(newTotal))
})
</script>

<template>
  <input type="number" v-model.number="price" />
  <input type="number" v-model.number="qty" />
  <p>Computed total: {{ total }}</p>
  <p>Method total: {{ totalMethod() }}</p>
</template>
```

At runtime the computed total updates once per dependency change and is cached between renders, while the method version recalculates on every render even when price and quantity have not moved.

### 5.3 `v-for` keys and the `v-if` + `v-for` trap

Two rules here, both common live-coding traps. First, every `v-for` needs a stable unique `:key`, and that key should be a real id, not the array index. Vue uses the key to match old and new nodes during a patch. If you key by index and the list reorders, inserts, or deletes, the indices shift and Vue reuses the wrong DOM nodes, which leaks component state across rows, so a checkbox or input value ends up on the wrong item. Second, never put `v-if` and `v-for` on the same element. In current Vue, `v-if` has higher priority and evaluates first, so it cannot see the loop variable. The fix is to filter the list in a `computed` and loop over the result.

```vue
<script setup>
import { ref, computed } from 'vue'

const todos = ref([
  { id: 1, text: 'ship', done: false },
  { id: 2, text: 'test', done: true },
  { id: 3, text: 'deploy', done: false },
])
const visible = computed(() => todos.value.filter(t => !t.done))  // filter here
</script>

<template>
  <!-- Correct: stable id key, filtering done in computed -->
  <ul>
    <li v-for="todo in visible" :key="todo.id">{{ todo.text }}</li>
  </ul>

  <!-- WRONG, do not do this:
  <li v-for="todo in todos" v-if="!todo.done" :key="index">...</li>
  v-if runs before v-for and cannot see todo; index keys cause state bleed. -->
</template>
```

The corrected version filters in `visible` and keys by `todo.id`. The commented-out version shows the two mistakes together: an index key and a same-element `v-if` that references a variable it cannot reach.

### 5.4 `v-if` vs `v-show`

Both hide content, with different mechanics and different costs. `v-if` adds and removes the element from the DOM entirely, so it is cheaper when something is rarely shown or expensive to render, and more costly to toggle repeatedly because each toggle mounts or unmounts. `v-show` always renders the element once and toggles its CSS `display`, so it is cheap to toggle but pays the render cost even while hidden.

Choose by toggle frequency: a tab you flip constantly uses `v-show`, a heavy panel you open occasionally uses `v-if`.

```vue
<script setup>
import { ref } from 'vue'
const open = ref(true)
</script>

<template>
  <button @click="open = !open">Toggle</button>
  <p v-if="open">v-if: removed from DOM when hidden</p>
  <p v-show="open">v-show: stays in DOM, display none when hidden</p>
</template>
```

### 5.5 Component contract: props down, events up

Vue enforces one-way data flow, and stating this clearly signals you understand component design rather than just syntax. Data flows down through props, and changes flow up through events. A child must never mutate a prop, because the parent owns that state and a mutation would desync the two. Instead the child emits an event, and the parent updates its own state in response. This is the same contract as Angular `@Input` and `@Output`, so your Angular experience maps directly.

```vue
<!-- TodoItem.vue -->
<script setup>
defineProps({ text: String, done: Boolean })
const emit = defineEmits(['toggle', 'remove'])
</script>

<template>
  <li>
    <input type="checkbox" :checked="done" @change="emit('toggle')" />
    <span :class="{ done }">{{ text }}</span>
    <button @click="emit('remove')">x</button>
  </li>
</template>

<style scoped>.done { text-decoration: line-through; }</style>
```

```vue
<!-- Parent.vue -->
<script setup>
import { ref } from 'vue'
import TodoItem from './TodoItem.vue'

const todos = ref([{ id: 1, text: 'learn', done: false }])
const toggle = (id) => {
  const t = todos.value.find(t => t.id === id)
  if (t) t.done = !t.done
}
const remove = (id) => { todos.value = todos.value.filter(t => t.id !== id) }
</script>

<template>
  <ul>
    <TodoItem
      v-for="t in todos" :key="t.id"
      :text="t.text" :done="t.done"
      @toggle="toggle(t.id)" @remove="remove(t.id)"
    />
  </ul>
</template>
```

The child renders from `text` and `done` and emits `toggle` and `remove`, owning no state. The parent holds the array and is the only place that mutates it. That separation is what makes components reusable and testable.

### 5.6 Two-way binding on a component with `defineModel`

`v-model` on a component is two-way binding sugar, and `defineModel` is the current, clean way to implement it. Calling `defineModel()` in the child gives you a writable ref wired to a `modelValue` prop and an `update:modelValue` event behind the scenes, so the parent writes `v-model="x"` and reads and writes through it as if it were local state. This removes the manual prop-plus-emit boilerplate that two-way component binding used to require.

```vue
<!-- MoneyInput.vue -->
<script setup>
const amount = defineModel({ type: Number, default: 0 })
</script>

<template>
  <input type="number" :value="amount" @input="amount = Number($event.target.value)" />
</template>
```

```vue
<!-- Parent.vue -->
<script setup>
import { ref } from 'vue'
import MoneyInput from './MoneyInput.vue'
const budget = ref(50)
</script>

<template>
  <MoneyInput v-model="budget" />
  <p>Budget is {{ budget }}</p>
</template>
```

Writing to `amount` in the child propagates up to `budget` in the parent, and a change to `budget` flows back down. One line in the child replaces a prop declaration and an emit.

### 5.7 Lifecycle and cleanup (the classic leak question)

Lifecycle hooks let you run code at defined moments: `onMounted` after the component is in the DOM, `onUnmounted` when it is removed. The interview trap is cleanup. Anything you start in `onMounted`, whether an interval, an event listener, a subscription, or a socket, must be torn down in `onUnmounted`, or it survives the component and leaks memory and CPU. A timer that keeps firing after its component is gone is the textbook example, and interviewers like to ask where this leaks.

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const seconds = ref(0)
let timer

onMounted(() => {
  timer = setInterval(() => { seconds.value++ }, 1000)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  clearInterval(timer)                       // without this, the timer leaks
  window.removeEventListener('resize', onResize)
})
function onResize() { /* ... */ }
</script>

<template><p>Mounted for {{ seconds }}s</p></template>
```

The fix is the symmetry: every `setInterval` has a `clearInterval`, every `addEventListener` has a `removeEventListener`, paired across mount and unmount.

### 5.8 Composables (reuse logic, the replacement for mixins)

A composable is a function that uses Vue's reactivity primitives and returns reactive state plus the functions that operate on it, named by convention `useSomething`. This is how you share stateful logic across components in the Composition API, and it replaces the old mixin approach cleanly. Mixins merged properties into a component implicitly, which caused name collisions and made it hard to see where a value came from. A composable is an explicit function call with an explicit return, so the source of every value is obvious. Frame it for the interviewer as the Composition API answer to Angular services and old Vue mixins, without the implicit naming problems mixins had.

```js
// useFetch.js
import { ref } from 'vue'

export function useFetch(url) {
  const data = ref(null)
  const error = ref(null)
  const loading = ref(true)

  fetch(url)
    .then(r => r.json())
    .then(json => { data.value = json })
    .catch(e => { error.value = e })
    .finally(() => { loading.value = false })

  return { data, error, loading }
}
```

```vue
<!-- Usage.vue -->
<script setup>
import { useFetch } from './useFetch'
const { data, error, loading } = useFetch('/api/todos')
</script>

<template>
  <p v-if="loading">Loading...</p>
  <p v-else-if="error">Failed: {{ error.message }}</p>
  <ul v-else><li v-for="t in data" :key="t.id">{{ t.text }}</li></ul>
</template>
```

Each call to `useFetch` creates its own independent `data`, `error`, and `loading` state, so two components calling it do not interfere. That independence is the point.

### 5.9 Slots, including a scoped slot

Slots are Vue's content projection, the equivalent of Angular `<ng-content>`. A default slot lets a parent pass markup into a child's layout. A named slot gives several labeled insertion points. A scoped slot is the powerful one and worth raising for a design-system role: it lets the child expose its internal data back up to the parent's slot content, so the child owns iteration and structure while the parent controls how each item renders. Angular has no clean equivalent, which makes it a good differentiator to mention.

```vue
<!-- DataList.vue -->
<script setup>
defineProps({ items: Array })
</script>

<template>
  <ul>
    <li v-for="item in items" :key="item.id">
      <slot name="row" :item="item">{{ item.label }}</slot>
    </li>
  </ul>
</template>
```

```vue
<!-- Parent.vue -->
<script setup>
import DataList from './DataList.vue'
const items = [{ id: 1, label: 'A' }, { id: 2, label: 'B' }]
</script>

<template>
  <DataList :items="items">
    <template #row="{ item }">
      <strong>#{{ item.id }}</strong> {{ item.label }}
    </template>
  </DataList>
</template>
```

`DataList` owns the loop and the list element, and hands each `item` back to the parent through the scoped `row` slot. The parent decides the markup for a row without ever touching the iteration. That is exactly the seam a multi-brand design system needs.

### 5.10 provide / inject (dependency injection across the tree)

`provide` and `inject` are Vue's dependency injection, for passing a value to deeply nested descendants without threading it through every intermediate component as props, which is the prop-drilling problem. An ancestor calls `provide('key', value)` once, and any descendant at any depth calls `inject('key')` to read it. Wrap the provided value in `readonly` so descendants cannot mutate shared state behind the owner's back, which keeps the one-way flow intact. This is the idiomatic way to distribute things like theme, locale, or a design-system configuration.

```vue
<!-- App.vue (ancestor) -->
<script setup>
import { provide, readonly, ref } from 'vue'
const theme = ref('dark')
provide('theme', readonly(theme))
</script>
```

```vue
<!-- DeepChild.vue -->
<script setup>
import { inject } from 'vue'
const theme = inject('theme', 'light')   // second arg is the default
</script>

<template><div :class="theme">Themed by inject</div></template>
```

The theme is provided once at the top and injected directly where it is needed, with a default value as the second argument to `inject` for when no ancestor provided it.

### 5.11 Reactive props destructure and `nextTick`

Two current-Vue details that come up in practice. First, you can destructure `defineProps` and the bindings stay reactive, with default values written inline, so `const { label = 'Default' } = defineProps(['label'])` is both concise and correct. Second, Vue applies DOM updates asynchronously and in batches, so right after you change state the DOM has not updated yet. `nextTick` returns a promise that resolves once Vue has flushed the update, which is when you can safely measure, scroll, or read the freshly rendered DOM.

```vue
<script setup>
import { nextTick, ref } from 'vue'

const { label = 'Default' } = defineProps(['label'])  // reactive, with default

const list = ref([])
async function addAndScroll() {
  list.value.push('row ' + (list.value.length + 1))
  await nextTick()                       // DOM now contains the new row
  // safe to measure or scroll here
}
</script>

<template>
  <p>{{ label }}</p>
  <button @click="addAndScroll">Add</button>
  <div v-for="row in list" :key="row">{{ row }}</div>
</template>
```

The component pushes a row, awaits `nextTick`, and only then is the new row present in the DOM and safe to measure or scroll to.

### 5.12 Pinia store

Pinia is the official state library, and the setup-style store shown here is the modern shape. It mirrors a component's `<script setup>`: `ref` for state, `computed` for getters, plain functions for actions, all returned from the store definition. When you consume the store and want to destructure its state, use `storeToRefs` so the extracted values keep their reactivity, the same lesson as `toRefs` from 5.1. Vuex is retired, so do not bring it up unless asked about migration.

```js
// stores/cart.js
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useCartStore = defineStore('cart', () => {
  const items = ref([])
  const total = computed(() => items.value.reduce((s, i) => s + i.price, 0))
  function add(item) { items.value.push(item) }
  function clear() { items.value = [] }
  return { items, total, add, clear }
})
```

```vue
<!-- Cart.vue -->
<script setup>
import { useCartStore } from './stores/cart'
import { storeToRefs } from 'pinia'

const cart = useCartStore()
const { items, total } = storeToRefs(cart)   // keep reactivity when destructuring
</script>

<template>
  <p>Items: {{ items.length }}, total: {{ total }}</p>
  <button @click="cart.add({ id: Date.now(), price: 9.99 })">Add</button>
  <button @click="cart.clear()">Clear</button>
</template>
```

`storeToRefs` is the detail that catches people: destructuring the store directly would break reactivity on `items` and `total`, exactly as destructuring a `reactive` object does, and `storeToRefs` is the fix.

---

## 6. React hooks versus Vue composables

The job touches both React and Vue, so this comparison is a common probe. Hooks and composables solve the same problem, reusing stateful logic across components, and both replaced older patterns (mixins in Vue, higher-order components and render props in React). Both are plain functions you call from a component. Every difference between them flows from one thing: the render model.

A React component function re-runs top to bottom on every render, so its hooks run on every render too, and React preserves state between renders through an internal slot keyed by call order. That single fact explains the Rules of Hooks (call them unconditionally, at the top level, in the same order every render), the dependency arrays on `useEffect`, and the existence of `useMemo` and `useCallback` to avoid recomputing or recreating values each render.

A Vue composable runs once, during `setup`. It creates reactive state with `ref` or `reactive`, returns it, and Vue tracks dependencies at the value level through its Proxy-based reactivity, re-rendering only what actually changed. Because the body does not re-run on updates, there are no dependency arrays, no `useMemo` or `useCallback`, and `computed` caches and re-tracks automatically.

The mapping:

| React | Vue | Note |
|---|---|---|
| `useState` | `ref` / `reactive` | Vue state is mutable through `.value`; React state is immutable with a setter |
| `useEffect` | `watch` / `watchEffect`, plus `onMounted` / `onUnmounted` | Vue separates lifecycle from reactivity and needs no dependency array |
| `useMemo` | `computed` | `computed` auto-tracks dependencies and caches; no deps array |
| `useCallback` | rarely needed | `setup` runs once, so functions are already stable |
| `useContext` | `inject` (with `provide`) | same dependency-injection idea |
| `useRef` for a DOM node | template `ref` | |
| a custom `useX` hook | a `useX` composable | both are functions returning state |

The same `useCounter` in each:

```js
// React: the hook runs on every render; deps arrays tell React what to memoize
function useCounter(initial = 0) {
  const [count, setCount] = useState(initial)
  const increment = useCallback(() => setCount(c => c + 1), [])
  const double = useMemo(() => count * 2, [count])
  return { count, increment, double }
}
```

```js
// Vue: setup runs once; computed auto-tracks; no deps arrays, no useCallback
function useCounter(initial = 0) {
  const count = ref(initial)
  const increment = () => count.value++
  const double = computed(() => count.value * 2)
  return { count, increment, double }
}
```

Two catches worth naming. First, stale closures are a frequent React bug and rarely a Vue one. Because a React hook re-runs and its callbacks capture that render's values, a callback can read outdated state unless you manage it with a dependency array or a ref, whereas a Vue composable reads through a stable `ref`, so the value is always current. Second, both have a "call it at the top, synchronously" rule, but for different reasons. React's comes from the call-order slot mechanism. Vue's is narrower: a composable that registers a lifecycle hook or calls `inject` must run synchronously during `setup`, because it needs the active component instance, so you cannot call such a composable after an `await` or conditionally.

The interview one-liner: both are functions for reusing stateful logic, and the difference is the render model. React re-runs the component and the hook every render, which is why it needs dependency arrays, the Rules of Hooks, and `useMemo` and `useCallback`. Vue runs `setup` once and tracks reactivity at the value level, so a composable needs none of those, and stale closures are far less of a problem.

---

## 7. Project scaffolds: the same TODO app, four toolchains

All four build or serve the same component. Save this as `src/TodoApp.vue` and reuse it (the no-bundler variant inlines an equivalent, since it has no SFC compiler).

```vue
<!-- src/TodoApp.vue -->
<script setup>
import { ref, computed } from 'vue'

const newTodo = ref('')
const todos = ref([
  { id: 1, text: 'Learn Vue reactivity', done: true },
  { id: 2, text: 'Build the todo app', done: false },
])
let nextId = 3

const remaining = computed(() => todos.value.filter(t => !t.done).length)

function add() {
  const text = newTodo.value.trim()
  if (!text) return
  todos.value.push({ id: nextId++, text, done: false })
  newTodo.value = ''
}
function remove(id) { todos.value = todos.value.filter(t => t.id !== id) }
</script>

<template>
  <section class="todo">
    <h1>Todos ({{ remaining }} left)</h1>
    <input v-model="newTodo" @keyup.enter="add" placeholder="Add a todo" />
    <button @click="add">Add</button>
    <ul>
      <li v-for="todo in todos" :key="todo.id">
        <label :class="{ done: todo.done }">
          <input type="checkbox" v-model="todo.done" /> {{ todo.text }}
        </label>
        <button @click="remove(todo.id)">x</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.done { text-decoration: line-through; opacity: 0.6; }
.todo { max-width: 420px; margin: 2rem auto; font-family: system-ui; }
</style>
```

```js
// src/main.js (used by Vite, Webpack, Gulp)
import { createApp } from 'vue'
import TodoApp from './TodoApp.vue'
createApp(TodoApp).mount('#app')
```

### 6.1 Vite (the recommended modern choice)

Fastest path: `npm create vue@latest` runs the official scaffolder with router, Pinia, Vitest, and TypeScript prompts. A minimal manual setup:

```json
// package.json
{
  "name": "todo-vite",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": { "vue": "^3.5.0" },
  "devDependencies": { "vite": "^8.0.0", "@vitejs/plugin-vue": "^6.0.0" }
}
```
```js
// vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    open: true,
    proxy: { '/api': 'http://localhost:3000' }   // forward API calls in dev
  },
  build: { outDir: 'dist', sourcemap: false }
})
```
```html
<!-- index.html (Vite uses this as the entry, at project root) -->
<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Todo (Vite)</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```
Run dev: `npm run dev`. Build: `npm run build`. Why Vite is fast: in dev it serves native ES modules and transforms files on demand with esbuild, so there is no upfront bundle. It bundles with Rollup only for production.

### 6.2 Webpack (the classic bundler)

```json
// package.json
{
  "name": "todo-webpack",
  "private": true,
  "scripts": {
    "dev": "webpack serve --mode development",
    "build": "webpack --mode production"
  },
  "dependencies": { "vue": "^3.5.0" },
  "devDependencies": {
    "webpack": "^5.99.0",
    "webpack-cli": "^6.0.0",
    "webpack-dev-server": "^5.2.0",
    "vue-loader": "^17.4.0",
    "@vue/compiler-sfc": "^3.5.0",
    "css-loader": "^7.1.0",
    "vue-style-loader": "^4.1.3",
    "html-webpack-plugin": "^5.6.0"
  }
}
```
```js
// webpack.config.js
const path = require('path')
const webpack = require('webpack')
const { VueLoaderPlugin } = require('vue-loader')
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = {
  entry: './src/main.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].[contenthash].js',
    clean: true,
  },
  resolve: { extensions: ['.js', '.vue'] },
  module: {
    rules: [
      { test: /\.vue$/, loader: 'vue-loader' },
      { test: /\.css$/, use: ['vue-style-loader', 'css-loader'] },
    ],
  },
  plugins: [
    new VueLoaderPlugin(),
    new HtmlWebpackPlugin({ template: './public/index.html' }),
    // Define Vue feature flags so dev-only code is removed from the bundle:
    new webpack.DefinePlugin({
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    }),
  ],
  devServer: { static: './dist', hot: true, port: 8080, open: true },
}
```
```html
<!-- public/index.html (template, no script tag, the plugin injects it) -->
<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Todo (Webpack)</title></head>
  <body><div id="app"></div></body>
</html>
```
Run dev: `npm run dev` serves on `http://localhost:8080` with hot module replacement. The caveat to know: `vue-loader` pre-compiles SFC templates so the runtime-only Vue build works, and the `DefinePlugin` feature flags strip dev code and silence warnings in production.

### 6.3 Pure npm, no bundler

Vue runs with no build step using native ES modules and an import map. There is no SFC compiler here, so the component uses a template string and Vue's full browser build (which includes the compiler). Good for prototypes and demos, not for production.

```html
<!-- index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Todo (no build)</title>
  <script type="importmap">
    { "imports": { "vue": "https://unpkg.com/vue@3/dist/vue.esm-browser.js" } }
  </script>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import { createApp, ref, computed } from 'vue'
    createApp({
      setup() {
        const newTodo = ref('')
        const todos = ref([{ id: 1, text: 'Run Vue with no build step', done: false }])
        let nextId = 2
        const remaining = computed(() => todos.value.filter(t => !t.done).length)
        const add = () => {
          const text = newTodo.value.trim()
          if (!text) return
          todos.value.push({ id: nextId++, text, done: false })
          newTodo.value = ''
        }
        const remove = (id) => { todos.value = todos.value.filter(t => t.id !== id) }
        return { newTodo, todos, remaining, add, remove }
      },
      template: `
        <h1>Todos ({{ remaining }} left)</h1>
        <input v-model="newTodo" @keyup.enter="add" placeholder="Add a todo" />
        <button @click="add">Add</button>
        <ul>
          <li v-for="t in todos" :key="t.id">
            <input type="checkbox" v-model="t.done" /> {{ t.text }}
            <button @click="remove(t.id)">x</button>
          </li>
        </ul>`
    }).mount('#app')
  </script>
</body>
</html>
```
```json
// package.json
{
  "name": "todo-no-build",
  "private": true,
  "scripts": { "dev": "npx serve .", "start": "npx http-server -o" }
}
```
Run: `npm run dev`, then open the served URL. Caveat to state out loud in an interview: this ships the in-browser compiler, which is larger and compiles templates at runtime. Fine for a demo, wrong for production. Production always uses a build step and the runtime-only build.

### 6.4 Gulp (task runner orchestrating a bundler)

Gulp is a task runner, not a module bundler, and modern SFC needs a bundler. The honest, practical setup uses Gulp to orchestrate the pipeline (bundle with esbuild, copy static, watch, live reload) while esbuild does the actual SFC compilation and bundling.

```json
// package.json
{
  "name": "todo-gulp",
  "private": true,
  "scripts": { "dev": "gulp dev", "build": "gulp build" },
  "dependencies": { "vue": "^3.5.0" },
  "devDependencies": {
    "gulp": "^5.0.0",
    "esbuild": "^0.25.0",
    "esbuild-plugin-vue3": "^0.4.2",
    "browser-sync": "^3.0.0"
  }
}
```
```js
// gulpfile.js
const gulp = require('gulp')
const esbuild = require('esbuild')
const vuePlugin = require('esbuild-plugin-vue3')
const browserSync = require('browser-sync').create()

const buildOptions = (prod) => ({
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'dist/bundle.js',
  sourcemap: !prod,
  minify: prod,
  plugins: [vuePlugin()],
  define: {                                   // strip Vue dev code
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
})

const bundle = (prod) => () => esbuild.build(buildOptions(prod))
const html = () => gulp.src('public/index.html').pipe(gulp.dest('dist'))
const reload = (done) => { browserSync.reload(); done() }

function serve() {
  browserSync.init({ server: './dist', port: 3000 })
  gulp.watch('src/**/*', gulp.series(bundle(false), reload))
  gulp.watch('public/index.html', gulp.series(html, reload))
}

exports.build = gulp.series(html, bundle(true))
exports.dev = gulp.series(html, bundle(false), serve)
```
```html
<!-- public/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Todo (Gulp)</title></head>
  <body><div id="app"></div><script src="bundle.js"></script></body>
</html>
```
Run dev: `npm run dev` bundles, serves on `http://localhost:3000` via BrowserSync, and live-reloads on change. Build: `npm run build`. The framing for an interviewer: Gulp earns its place as the orchestrator for a multi-step asset pipeline (Sass, image optimization, copying, bundling). It delegates module bundling to a real bundler rather than doing it alone.

---

## 8. Local development servers

**Vite dev server** (`vite`). Serves source as native ES modules with on-demand transform, so startup is near-instant and stays flat as the project grows. Hot module replacement is built in and precise. API proxying via `server.proxy`. This is the default you should reach for.

**webpack-dev-server** (`webpack serve`). Bundles the app in memory and serves from memory, with HMR enabled by `hot: true`. Cold start and rebuilds get slower as the graph grows, since it bundles up front. API proxying via `devServer.proxy`. Still common in established codebases.

Both share the same dev concerns: enable HMR, proxy your backend to avoid CORS, bind a stable port, and keep source maps on in development. The practical difference is startup and rebuild speed, where Vite wins because it does not bundle during development.

---

## 9. Production deployment best practices

Lead with these in an architecture discussion. They are staff-level signals.

**Build correctly.** Ship a bundled, minified, tree-shaken build from the runtime-only Vue (never the in-browser compiler or full build). Set the Vue feature flags (`__VUE_OPTIONS_API__`, `__VUE_PROD_DEVTOOLS__`, `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`) to `false` so dev code is removed. Set `NODE_ENV=production`.

**Split and lazy-load.** Use dynamic `import()` for route-level components and `defineAsyncComponent` for heavy widgets, so the initial bundle stays small. Measure with `rollup-plugin-visualizer` (Vite) or `webpack-bundle-analyzer`, and hold a performance budget in CI.

**Cache aggressively and safely.** Emit content-hashed filenames (`[name].[contenthash].js`). Serve hashed assets with long-lived immutable cache headers, and serve `index.html` with no-cache so new deploys are picked up immediately.

**Compress and serve from the edge.** Enable Brotli or gzip at the server or CDN. A static SPA deploys cleanly to S3 plus CloudFront, Cloudflare Pages, Netlify, Vercel, or an Nginx box. Put a CDN in front.

**Handle SPA routing.** With Vue Router history mode, configure the server to rewrite unknown paths to `index.html`, or deep links 404.

**Address SEO and first paint when it matters.** For marketing, product, and listing pages, render on the server or prerender. Nuxt gives SSR and static generation. Watch for hydration mismatches: no `window` or `document` during server render, gate browser-only code behind `onMounted` or `import.meta.client`, and avoid non-deterministic render (dates, random, locale) that differs between server and client.

**Operate it.** Generate source maps and upload them to your error tracker (Sentry) rather than serving them publicly. Add a health check and basic web-vitals monitoring. Commit the lockfile, pin the Node version, and build reproducibly in CI.

**Containerize with a multi-stage image.** Build with Node, serve the static output with Nginx.
```dockerfile
# build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# serve stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```
```nginx
# nginx.conf
server {
  listen 80;
  root /usr/share/nginx/html;

  location / {
    try_files $uri $uri/ /index.html;   # SPA fallback for Vue Router history mode
  }
  location ~* \.(js|css|png|svg|woff2)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

---

## 10. Testing (the job names Jest and Cypress)

Unit and component tests use **Vue Test Utils** (`@vue/test-utils`) with `mount` (full render) or `shallowMount` (stub children). The idiomatic runner today is **Vitest**, which shares Jest's API and runs faster on Vite projects. Position it as: you set up Jest and Cypress before, and on a Vite/Vue codebase you reach for Vitest for the same reasons with a familiar API.

```js
import { mount } from '@vue/test-utils'
import TodoApp from '../src/TodoApp.vue'

test('adds a todo on enter', async () => {
  const wrapper = mount(TodoApp)
  await wrapper.find('input').setValue('write tests')
  await wrapper.find('input').trigger('keyup.enter')
  expect(wrapper.text()).toContain('write tests')
})
```
End-to-end and component testing use **Cypress** (you have done this). Test behavior through the rendered output and emitted events, not internal refs.

---

## 11. Live-coding katas to drill this week

Build each from scratch in a Vite scaffold until it is reflexive:

1. Counter with reset and a `computed` doubled value.
2. Debounced search filter using `watch` with a cleared timeout.
3. A reusable `<BaseInput>` with `defineModel`, used twice in a parent.
4. The TODO app in section 7, with a `computed` remaining count and stable keys.
5. A `useFetch` composable exposing `data`, `error`, `loading`.
6. A Pinia store with state, a getter, and an action, consumed by two components.

---

## 12. Framing your background (staff-level signal)

Lead with what already matches the posting. Do not apologize for the Vue ramp.

- "Use AI to solve practical problems and improve team efficiency" is a stated requirement. Your AI-assisted frontend work is direct evidence. Have a concrete story: what you delegated to the agent, where you reviewed and corrected, what shipped.
- You set up Cypress and Jest yourself. That is the testing requirement, answered.
- Angular, Webix, and ExtJS across 18 years is exactly the "large complex projects over a long period" and "many codebases" they ask for. Pitch yourself as someone who reasons from first principles (reactivity, component contracts, one-way data flow), so Vue specifics are a short ramp.
- Multi-brand design system: talk component API design, scoped slots for consumer customization, design tokens via `provide`/`inject` or CSS variables, and how you keep consistency across many codebases. This is the staff-level thinking they want.
- Know what is current: Vue 3.5 today, Vapor mode landing in 3.6, Vite 8, Pinia, Vitest, Nuxt for SSR. Naming the trajectory shows you keep up, which the posting asks for explicitly.

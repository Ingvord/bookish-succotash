# TypeScript: Medium-Level Interview Preparation

This guide targets the exact TypeScript questions the interview script covers.
Based on actual evaluation feedback, the bar is "medium level": practical
knowledge of why TypeScript exists, the key design decisions in the type system,
and TypeScript applied in Vue. The two questions where candidates lose points are
`type` vs `interface` and `unknown` vs `any`. Start there.

One fact to anchor everything: TypeScript is erased at runtime. Every annotation,
interface, and generic disappears before your code reaches the engine. TypeScript
is entirely a compile-time tool. That single truth shapes how every feature works
and why the tradeoffs are what they are.

---

## 1. Why TypeScript (complete answer, not just "catches errors")

The partial answer most candidates give: "it catches type errors at compile time."
That is true but incomplete. A complete answer covers four dimensions.

**Safety.** TypeScript catches whole classes of runtime errors before they ship:
property access on `null`, typos in property names, calling something that is not
a function, passing the wrong argument count. In a large Vue codebase these
failures are silent and expensive without types.

**Tooling.** Types are the data that powers autocompletion, refactoring, and
inline documentation in every modern editor. When you rename a prop with TypeScript
the editor renames every usage. Without types it guesses.

**Communication.** A function signature with types is a contract visible to every
future reader without running the code. A design system component with typed props
is self-documenting.

**Scale.** Untyped JavaScript degrades as teams and codebases grow, because
nothing enforces contracts between modules. TypeScript keeps that cost flat.

The interview follow-up to prepare for: "When would you not use TypeScript?" Fair
answer: prototypes, short scripts, and teams with no TypeScript experience where
the ramp-up cost exceeds the benefit in the timeframe. Not a dogmatic choice.

---

## 2. `type` vs `interface`: the most-asked TypeScript question

This is the question the interview specifically flagged as not explained. Know it
completely.

Both `type` and `interface` describe the shape of a value. Both can describe
objects, both can be extended, and in most everyday use they are interchangeable.
The three differences that matter are declaration merging, union expressiveness,
and community convention.

**Difference 1: only `interface` supports declaration merging.** When you write
two `interface` declarations with the same name, TypeScript merges them into one.
This is how module augmentation works: adding a property to the global `Window`
interface, extending a third-party type without forking it, or augmenting Vue's
component instance. `type` silently refuses this and produces an error.

```ts
// Declaration merging: only interface
interface Window { analytics: Analytics }    // augments the built-in Window
interface Window { featureFlags: string[] }  // merges again: both properties now exist

// Type alias with the same name is a duplicate identifier error:
type Point = { x: number }
type Point = { y: number }  // ERROR: duplicate identifier
```

**Difference 2: only `type` can express unions, intersections, and mapped
shapes.** Any time the shape cannot be described as a plain object, you need
`type`.

```ts
// Union: only type
type ID = string | number
type Status = 'active' | 'inactive' | 'suspended'
type Nullable<T> = T | null

// Intersection: both work, with different syntax
interface AdminI extends UserI { role: string }    // interface with extends
type AdminT = UserT & { role: string }             // type with intersection

// Mapped type: only type
type Readonly<T> = { readonly [K in keyof T]: T[K] }
```

**Difference 3: convention.** Use `interface` for public API surfaces (library
exports, design-system component props, class shapes) because consumers can
extend them. Use `type` for internal logic, unions, and anything requiring mapped
or conditional type power. Many teams simply pick one and stay consistent, which
is a perfectly valid answer.

```ts
// Public prop definition: interface is conventional
interface ButtonProps {
  label: string
  variant?: 'primary' | 'secondary'
  disabled?: boolean
  onClick?: () => void
}

// Internal computed shape: type is natural
type ButtonState = {
  isLoading: boolean
  isFocused: boolean
}
```

The interview one-liner: "Both describe object shapes. Interface merges
declarations, which is how module augmentation works, so it is preferred for
public APIs. Type handles unions and mapped shapes that interface cannot express."

---

## 3. `unknown`, `any`, and `never`: the type-safety gradient

These three types sit at the extremes of TypeScript's system and each has a
precise meaning. Knowing the gradient and the catch on each is the full answer.

**`any` disables the type system entirely.** You can do anything with an `any`
value: access any property, call it as a function, pass it anywhere. TypeScript
stops checking. The catch: any is contagious. A value that touches `any` spreads
the unsafety. Use it only as a last resort when migrating untyped code, and flag
it with a comment explaining why.

**`unknown` is the type-safe counterpart.** You can assign any value to `unknown`
just like `any`, but you cannot do anything with it until you narrow its type
first. The catch that the partial answer misses: `unknown` does not remove safety,
it defers it to the call site, which is exactly right for values whose type you
genuinely do not know at write time.

```ts
// any: door wide open
const parsed: any = JSON.parse(userInput)
parsed.anything.you.want   // no error, no safety

// unknown: requires narrowing before use
const safe: unknown = JSON.parse(userInput)
safe.anything              // ERROR: object is of type unknown
if (typeof safe === 'object' && safe !== null && 'name' in safe) {
  console.log((safe as { name: string }).name)  // now safe
}

// Practical pattern: validate at the boundary, type the interior
function processApiResponse(raw: unknown): User {
  if (!isUser(raw)) throw new Error('Unexpected shape')
  return raw  // narrowed to User by the type guard
}
```

**`never` represents a value that can never occur.** A function that always
throws or runs an infinite loop returns `never`. An empty union resolves to
`never`. Its primary use is exhaustive checks: if you add a new union member and
forget to handle it, TypeScript produces a type error where the `never` is
assigned.

```ts
// Exhaustive check with never
type Shape = 'circle' | 'square' | 'triangle'

function area(s: Shape): number {
  if (s === 'circle') return Math.PI
  if (s === 'square') return 1
  if (s === 'triangle') return 0.5
  const _exhaustive: never = s   // if you add 'pentagon' to Shape and forget a branch,
  throw new Error(_exhaustive)   // TypeScript errors here, not at runtime
}
```

---

## 4. Generics: types as parameters

Generics are the mechanism that makes reusable, type-safe functions and data
structures possible. The mental model: if regular functions take values as
parameters, generic functions take types as parameters.

Without generics, a function that returns its argument must be typed as `any`
(unsafe) or written once per type (maintenance nightmare). With generics, one
definition serves all types while preserving the relationship between them.

```ts
// Without generics: unsafe or duplicated
function identity(x: any): any { return x }

// With generics: the return type follows the input type
function identity<T>(x: T): T { return x }
const n = identity(42)        // inferred as number
const s = identity('hello')   // inferred as string

// Generic interface
interface Box<T> { value: T; transform: (v: T) => T }

// Constraints: T must have a length property
function longest<T extends { length: number }>(a: T, b: T): T {
  return a.length >= b.length ? a : b
}
longest('hello', 'hi')       // works: strings have length
longest([1, 2], [3])         // works: arrays have length
longest(10, 20)              // ERROR: number has no length
```

The interview framing: "Generics let you write a function or type once and have
TypeScript infer the concrete type at each call site, preserving type safety
without duplication. Constraints narrow what types are valid."

---

## 5. Utility types: the standard toolkit

TypeScript ships with a library of generic utility types that transform existing
types rather than defining new ones from scratch. These come up in code reviews
and API design discussions at the medium level.

```ts
interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'viewer'
}

// Partial: all properties become optional (useful for update payloads)
type UserUpdate = Partial<User>                // { id?: number; name?: string; ... }

// Required: all optional properties become required
type StrictUser = Required<User>

// Readonly: all properties become read-only (good for props)
type ImmutableUser = Readonly<User>

// Pick: select a subset of properties
type UserPreview = Pick<User, 'id' | 'name'>   // { id: number; name: string }

// Omit: exclude properties
type PublicUser = Omit<User, 'role'>           // no role field

// Record: map type (keys to values)
type RoleMap = Record<User['role'], string[]>  // { admin: string[]; viewer: string[] }

// ReturnType: extract a function's return type
function fetchUser() { return { id: 1, name: 'Ada' } }
type FetchResult = ReturnType<typeof fetchUser>  // { id: number; name: string }

// NonNullable: remove null and undefined
type SafeId = NonNullable<number | null | undefined>  // number
```

The staff-level move is reaching for these instead of rewriting interface shapes
by hand: "I defined the full entity type once and derived the create, update, and
preview shapes from it with Pick and Omit, so they stay in sync automatically."

---

## 6. Type narrowing and discriminated unions

TypeScript understands control flow. Inside an `if` block that checks `typeof`,
`instanceof`, or property existence, the type narrows to the matching branch. This
is not magic; it is the compiler tracking which values are possible at each point.

```ts
// typeof narrowing
function format(value: string | number): string {
  if (typeof value === 'string') return value.toUpperCase()  // string here
  return value.toFixed(2)                                    // number here
}

// instanceof narrowing
function handle(err: Error | string) {
  if (err instanceof Error) return err.message  // Error here
  return err                                    // string here
}

// in narrowing: check for property existence
type Cat = { meow: () => void }
type Dog = { bark: () => void }
function speak(animal: Cat | Dog) {
  if ('meow' in animal) animal.meow()
  else animal.bark()
}
```

The pattern that signals real TypeScript experience is the discriminated union.
Add a shared literal property (`kind`, `type`, `status`) to each member of a
union and TypeScript narrows automatically, with no casting.

```ts
// Discriminated union: the 'ok' field is the discriminant
type ApiResult =
  | { ok: true;  data: User }
  | { ok: false; error: string }

function process(result: ApiResult) {
  if (result.ok) {
    console.log(result.data.name)   // TypeScript knows data exists here
  } else {
    console.error(result.error)     // and error exists here
  }
}
```

This pattern is especially strong in Vue: a component prop typed as a
discriminated union lets the template narrow automatically based on which branch
is active.

---

## 7. TypeScript in Vue SFCs

TypeScript in a Vue single-file component adds `lang="ts"` to the script block
and uses the Composition API's typed variants.

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'

// Typed props: generic syntax on defineProps
const props = defineProps<{
  label: string
  count?: number
  variant?: 'primary' | 'secondary'
}>()

// Typed emits
const emit = defineEmits<{
  increment: [amount: number]
  reset: []
}>()

// Typed refs
const input = ref<HTMLInputElement | null>(null)
const doubled = computed<number>(() => (props.count ?? 0) * 2)
</script>
```

The typed generic syntax for `defineProps` and `defineEmits` is cleaner than the
runtime object syntax and gives full inference without any runtime overhead.

For defineModel with a type:
```ts
const model = defineModel<string>({ required: true })
```

---

## 8. Strict mode, tsconfig, and a complete answer on `use strict`

TypeScript adds its own strict layer on top of JavaScript's `'use strict'`. The
two are related but not the same.

**JavaScript `'use strict'`** changes a handful of runtime behaviours: disallows
undeclared variable assignment, makes `this` `undefined` in plain function calls
rather than the global, turns silent failures into thrown errors, and reserves
additional keywords. **The partial answer candidates miss**: ES modules and class
bodies are always in strict mode automatically, without writing `'use strict'`.
Any `.mjs` file, any file in a `type: "module"` package, and any `class` body
runs in strict mode whether you write the directive or not.

**TypeScript's strict mode** is different and more powerful. Setting `"strict": true`
in `tsconfig.json` enables a group of compiler checks:

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "paths": { "@/*": ["./src/*"] },
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

`strict: true` covers `noImplicitAny` (no untyped parameters), `strictNullChecks`
(null and undefined are not assignable to other types), `strictFunctionTypes`, and
several others. Without `strictNullChecks` specifically, TypeScript is far less
useful: `null` can be assigned to anything and the class of errors it was designed
to catch does not surface.

---

## 9. `window` and `document` in a TypeScript and SSR context

The JavaScript question "which loads first, window or document?" has a plain
answer and a SSR extension that is directly relevant to Nuxt.

**Plain answer.** `window` is the global object and exists as soon as the
JavaScript runtime starts. `document` is `window.document`, the DOM interface
built as the HTML parser processes the markup. So `window` is the container and
`document` is content within it. `DOMContentLoaded` fires when the DOM is parsed
and ready; `load` fires when all resources (images, scripts, fonts) are loaded.

**SSR extension.** In a Nuxt or server-rendered Vue application, code runs first
on the server where neither `window` nor `document` exists. Accessing either
directly in a component's `<script setup>` causes a runtime error during server
rendering. The correct pattern:

```ts
import { onMounted } from 'vue'
import { useNuxtApp } from '#app'

// Gate all browser-only access inside onMounted:
onMounted(() => {
  const width = window.innerWidth    // safe: onMounted only runs in the browser
  document.title = 'Hello'          // safe
})

// Or use the Nuxt helper:
if (import.meta.client) {
  // runs only on the client, not during SSR
}
```

This extends the JS question into the SSR/Nuxt context and signals you have
connected the knowledge, which is exactly what a staff-level answer looks like.

---

## 10. Practice questions (what the interview actually asked)

Use the bold phrase as the question and cover the answer without looking.

**Why TypeScript over plain JavaScript?** Compile-time type safety, better
tooling, self-documenting contracts, and large-codebase scalability. It is erased
at runtime, so it adds zero overhead to the shipped code.

**What is the difference between `type` and `interface`?** Both describe object
shapes. Interface supports declaration merging (module augmentation) and is
preferred for public APIs. Type handles unions, intersections, and mapped shapes
that interface cannot express. In practice, many codebases pick one and stay
consistent.

**What is `unknown` and when do you use it over `any`?** Any disables type
checking entirely. Unknown accepts any value but forces narrowing before use. Use
unknown for values of genuinely uncertain type (JSON payloads, API responses).
Use any only when migrating untyped code.

**What is `never`?** A type that represents a value that can never exist: the
return type of functions that always throw, and the resolved type of an empty
union. Its most practical use is exhaustive checks in switch statements.

**What are some common utility types?** Partial, Required, Readonly, Pick, Omit,
Record, ReturnType, NonNullable. Reach for these to derive shapes from existing
types rather than duplicating definitions.

**Is `use strict` necessary in modern JavaScript?** ES modules and class bodies
are always strict automatically. In TypeScript, the compiler enforces stricter
rules still via `strict: true` in tsconfig.

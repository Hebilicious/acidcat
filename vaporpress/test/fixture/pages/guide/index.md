---
title: Guide
description: How the fixture works.
---

<script setup>
import Counter from "../../src/Counter.vue";
</script>

# The guide

A paragraph of Markdown, with `inline {{ code }}` and a [link to the long page](/guide/long/).

![A blue diagram](./diagram.png "The diagram")

## Components in Markdown

<Counter :start="5">

The slot holds **Markdown**.

</Counter>

## Code

```ts title="example.ts"
const answer: number = 1 < 2 ? 42 : 0;
```

### A smaller heading

Text under the smaller heading.

![The same diagram, further down](./diagram.png)

<style>
#the-guide { color: rgb(1, 2, 3); }
</style>

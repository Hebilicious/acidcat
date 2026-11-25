<script setup lang="ts" vapor>
import { data } from "../src/components/packages.data.ts";
import PackagesPage from "../src/components/PackagesPage.vue";
import { packageHeadings } from "../src/lib/package-groups.ts";

defineOptions({
  __page: {
    title: "Packages",
    description: "Every package that AcidCat publishes, with its registry, its latest version and how to install it.",
    frontmatter: { editLink: false },
    headings: packageHeadings(data),
  },
});
</script>

<template>
  <PackagesPage />
</template>

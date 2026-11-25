<script setup lang="ts" vapor>
import { data } from "../../components/packages.data.ts";
import PackagesPage from "../../components/PackagesPage.vue";
import { packageHeaders } from "../../lib/package-groups.ts";

defineOptions({
  __page: {
    title: "Packages",
    description: "Every package that AcidCat publishes, with its registry, its latest version and how to install it.",
    frontmatter: { editLink: false },
    headings: packageHeaders(data),
  },
});
</script>

<template>
  <PackagesPage />
</template>

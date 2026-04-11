// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  // i18n: English is the default and lives at /, Spanish at /es/, Portuguese at /pt/.
  // The terminal UI chrome (help copy, prompts, error messages, labels) is localized
  // via src/i18n/{en,es,pt}.json — commands and flags stay in English across every
  // locale on purpose, since this is meant to feel like a real CLI. User-generated
  // content (hackathon name/description/tags) is shown in whatever language the
  // publisher wrote it in; we don't machine-translate the data itself.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es', 'pt'],
    routing: {
      prefixDefaultLocale: false,
    },
    // No `fallback` — each locale has a complete page at src/pages/<locale>/
    // index.astro, so we don't want Astro generating route fallback stubs
    // that collide with the explicit pages. String-level fallback is handled
    // inline by the t() helper, which falls through to the key name.
  },
});

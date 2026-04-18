<style>
    .poem {
        font-family: Georgia, 'EB Garamond', serif !important;
        font-style: italic !important;
        white-space: pre-line !important;
        text-align: left !important;
        text-indent: 0 !important;
        hyphens: none !important;
        line-height: 1.5 !important;
        margin: 1.5em 0 1.5em 1em !important;
        padding: 0 0 0 1em !important;
        border-left: 2px solid #c8bfad !important;
    }
    .poem p,
    .page-content .poem p,
    .editor-content-area .poem p {
        text-align: left !important;
        text-indent: 0 !important;
        hyphens: none !important;
        margin: 0 0 0.6em 0 !important;
        line-height: 1.5 !important;
        font-style: italic !important;
    }
</style>

<script>
    // Alt-Editor (TinyMCE): registriert „Gedicht" im Formats-Dropdown.
    window.addEventListener('editor-tinymce::pre-init', function (event) {
        const cfg = event.detail.config;

        cfg.formats = Object.assign({}, cfg.formats, {
            poem: { block: 'div', classes: 'poem', wrapper: true }
        });

        cfg.style_formats = [
            ...(cfg.style_formats || []),
            { title: 'Gedicht', format: 'poem' }
        ];

        cfg.style_formats_merge = true;

        cfg.content_style = (cfg.content_style || '') +
            ' .poem { font-family: Georgia, serif; font-style: italic;' +
            ' white-space: pre-line; text-align: left; text-indent: 0;' +
            ' hyphens: none; line-height: 1.5;' +
            ' margin: 1.5em 0 1.5em 1em; padding: 0 0 0 1em;' +
            ' border-left: 2px solid #c8bfad; }' +
            ' .poem p { text-align: left; text-indent: 0; hyphens: none;' +
            ' margin: 0 0 0.6em 0; }';
    });

    // Neuer Editor (Lexical, wysiwyg2024): eigenen Toolbar-Button „Gedicht".
    // API-Stabilität laut BookStack-Docs: „may change without notice".
    window.addEventListener('editor-wysiwyg::post-init', function (event) {
        const { usage, api } = event.detail;
        if (usage !== 'page-editor') return;

        try {
            const button = api.ui.createButton({
                label: 'Gedicht',
                action() {
                    api.content.insertHtml(
                        '<div class="poem"><p>Erste Zeile</p><p>Zweite Zeile</p></div>'
                    );
                }
            });

            const toolbar = api.ui.getMainToolbar();
            const sections = toolbar.getSections();
            const lastSection = sections[sections.length - 1];
            if (lastSection && typeof lastSection.addButton === 'function') {
                lastSection.addButton(button);
            }
        } catch (e) {
            console.warn('[theme] Gedicht-Button konnte nicht registriert werden:', e);
        }
    });
</script>

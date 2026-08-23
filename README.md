# Arabic Name Standardizer

A privacy-first Chrome extension that converts Arabic personal names into one consistent English spelling—inside web forms or across entire spreadsheets.

إضافة لمتصفح Chrome لتوحيد كتابة الأسماء العربية باللغة الإنجليزية، سواءً داخل حقول المواقع أو في ملفات Excel والقوائم الكبيرة، مع معالجة محلية تحافظ على الخصوصية.

## Features

- Standardizes one Arabic name from the extension popup.
- Suggests a consistent spelling while typing in ordinary web form fields.
- Processes complete columns from CSV, XLSX, TSV, and TXT files.
- Preserves row order and blank rows when processing spreadsheets.
- Exports standardized results to CSV or XLSX.
- Combines a built-in dictionary with rule-based transliteration.
- Lets users approve preferred spellings and save local overrides.
- Supports Arabic and English interfaces with RTL/LTR layouts.
- Generates an ICAO-style MRZ representation where applicable.
- Runs locally with no network access or external API.

## الخصائص

- توحيد اسم عربي واحد من النافذة المنبثقة.
- اقتراح الصيغة الإنجليزية أثناء الكتابة في حقول المواقع العادية.
- معالجة أعمدة كاملة من ملفات CSV وXLSX وTSV وTXT.
- الحفاظ على ترتيب الصفوف والصفوف الفارغة.
- تصدير النتائج إلى CSV أو Excel.
- الجمع بين قاموس داخلي وقواعد آلية للنقل الصوتي.
- حفظ الصيغ التي يعتمدها المستخدم محليًا.
- واجهة عربية وإنجليزية مع دعم RTL وLTR.
- العمل محليًا دون اتصال شبكي أو خدمات خارجية.

## Installation from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository folder containing `manifest.json`.

## Usage

### Single name

Select the extension icon, enter an Arabic name, then copy the standardized form.

### Web forms

Type an Arabic name into a normal text field. The extension offers a spelling suggestion without changing the field unless you accept it.

### Spreadsheets and lists

Open **Convert a whole column**, paste cells from Excel or Google Sheets, or upload a supported file. Review uncertain names, approve preferred spellings, then copy or download the results.

## Privacy and permissions

All conversion is performed inside the browser. The extension's Content Security Policy sets `connect-src 'none'`, and it does not send names to a server.

The extension requests:

- `storage` to keep language settings and approved spellings locally.
- `activeTab` and `scripting` to provide suggestions in the current page.
- `contextMenus` to expose relevant extension actions.

Sensitive password, payment, PIN, CVV, one-time-code, and similar fields are excluded from the form assistant.

## Project structure

```text
├── manifest.json
├── icons/
├── _locales/
└── src/
    ├── background/   # Extension service worker
    ├── bulk/         # Spreadsheet and list workflow
    ├── content/      # In-page form assistant
    ├── engine/       # Normalization, dictionary, rules, and file handling
    ├── i18n/         # Arabic and English interface strings
    ├── options/      # Approved spellings and settings
    ├── popup/        # Single-name interface
    ├── theme/        # Shared visual styles
    └── welcome/      # First-run page
```

## Development

The extension uses native JavaScript modules and does not require a build step. After editing, reload it from `chrome://extensions`.

Basic syntax validation can be run with Node.js:

```bash
find . -name '*.js' -print0 | xargs -0 -n1 node --check
```

## Version

Current release: **3.0.0**

## License

Released under the [MIT License](LICENSE).


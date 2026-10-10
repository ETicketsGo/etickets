# Self-hosted fonts

The three web apps load Inter and Plus Jakarta Sans from this folder, so `next build` never
downloads anything from Google Fonts. With `next/font/google`, a failed download at build time
failed the whole build ("An error occurred in `next/font`").

How it fits together:

- `../src/fonts/inter.ts` and `../src/fonts/display.ts` load the **latin** file with
  `next/font/local`. Next preloads it, sets `--font-inter` / `--font-display` exactly as
  `next/font/google` did (`"Inter","Inter Fallback"`), and names the family as Google did.
- `inter.css` and `plus-jakarta-sans.css` hold the size-matched Arial fallback face and the
  other Google subsets (latin-ext, which has the rupee sign, plus cyrillic, greek and
  vietnamese) under the same family name. A browser downloads one of these only when a page
  shows a character from it, as it did from Google.

## Source

From https://github.com/google/fonts (licence: SIL Open Font License 1.1):

| Family                  | google/fonts file                               | google/fonts commit                        | Upstream                                    |
| ----------------------- | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| Inter 4.001             | `ofl/inter/Inter[opsz,wght].ttf`                | `0b58fb370093f9a9f4ff785d94405710b79de67c` | https://github.com/rsms/inter               |
| Plus Jakarta Sans 2.071 | `ofl/plusjakartasans/PlusJakartaSans[wght].ttf` | `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` | https://github.com/tokotype/PlusJakartaSans |

`OFL-Inter.txt` and `OFL-PlusJakartaSans.txt` are the licence files from the same commits,
unchanged. Italic files are not included: no app uses an italic Inter or Plus Jakarta Sans.

## Regenerating

`make-fonts.py` writes every `.woff2` and both `.css` files. It cuts each source file into
Google's unicode-range subsets, keeps the OpenType features Google keeps, and pins Inter's
optical-size axis at 14 the way Google serves Inter when only weights are asked for. Output is
byte-for-byte repeatable.

```sh
pip install fonttools brotli
python make-fonts.py "path/to/Inter[opsz,wght].ttf" "path/to/PlusJakartaSans[wght].ttf"
```

If you change a unicode range there, change the latin range in `../src/fonts/*.ts` too
(next/font only accepts literal options, so it cannot import it).

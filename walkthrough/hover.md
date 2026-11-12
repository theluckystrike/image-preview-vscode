## Hover an image path

The hover shows the image, then its type, its size in pixels and on disk, and whether it has transparency.

- `@/assets/logo.svg` and other tsconfig or jsconfig `paths` resolve on their own.
- `/banner.png` is looked up in `public/`, `static/` and the other web root folders.
- `hero%20image.png` and `hero image.png` both work, and `?v=2` or `#id` after the name is ignored.
- A remote URL shows as a link. Nothing is downloaded.

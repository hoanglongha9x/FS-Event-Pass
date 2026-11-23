// Rebuild the checked-in stylesheet after changing utility classes.
// npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i styles/tailwind.input.css -o tailwind.css --minify
module.exports = {
  content: {
    relative: true,
    files: [
      "./index.html",
      "./event-ui.js",
      "./event-admin.js",
      "./event-excel.js",
      "./event-roster.js",
      "./event-images.js",
      "./student-pass.js"
    ]
  }
};

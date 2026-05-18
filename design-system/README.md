# Bold Sports Design System

A shared CSS design system for the CFB/fitness app suite. One file, five apps, consistent feel — only the gradient changes per app.

**Live sampler:** [View all 5 apps →](https://colemccall.github.io/VibeCodeSandbox/v3/)

---

## Quick Start

```html
<!-- 1. Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">

<!-- 2. Design system -->
<link rel="stylesheet" href="path/to/theme.css">

<!-- 3. App theme class on your root element -->
<body class="app-road-grid">
  <div class="bs-card">
    ...
  </div>
</body>
```

---

## App Color Themes

Apply one class to your root element or `.bs-card`. Everything else inherits.

| App | Class | Gradient | Accent |
|---|---|---|---|
| Road Grid Guesser | `.app-road-grid` | Blue `#1E40AF` → Purple `#6D28D9` | Indigo `#4F46E5` |
| Highway Trivia | `.app-highway` | Amber `#B45309` → Red `#DC2626` | Orange `#C2410C` |
| Stadium Bucket List | `.app-stadium` | Forest `#065F46` → Navy `#1E40AF` | Emerald `#047857` |
| Conference Realignment | `.app-realignment` | Burgundy `#7C2D12` → Bronze `#92400E` | Bronze `#92400E` |
| Fitness Visualizer | `.app-fitness` | Red `#DC2626` → Orange `#EA580C` | Red `#DC2626` |

To create a new app theme, override three variables:

```css
.app-my-new-app {
  --grad-a:        #startColor;
  --grad-b:        #endColor;
  --accent:        #interactiveColor;
  --accent-light:  #tintBackground;   /* usually accent at ~8% opacity */
}
```

---

## Component Reference

### Card Shell

Every app renders inside `.bs-card`. Apply the app theme class here.

```html
<div class="bs-card app-road-grid">
  <!-- header, content, result -->
</div>
```

---

### Header

```html
<div class="bs-header">
  <div class="bs-header-top">

    <div>
      <div class="bs-logo">Road Grid</div>
      <div class="bs-logo-sub">Daily Challenge · #47</div>
    </div>

    <div class="bs-badges">
      <div class="bs-badge">
        <span class="bs-badge-num">7</span>
        <span class="bs-badge-lbl">Streak</span>
      </div>
      <div class="bs-badge">
        <span class="bs-badge-num">14</span>
        <span class="bs-badge-lbl">Best</span>
      </div>
    </div>

  </div>

  <!-- Optional tab navigation -->
  <div class="bs-tabs">
    <button class="bs-tab active">Easy</button>
    <button class="bs-tab">Medium</button>
    <button class="bs-tab">Hard</button>
  </div>
</div>
```

---

### Puzzle Image Area

```html
<div class="bs-puzzle">
  <div class="bs-puzzle-img" data-prompt="What city is this?">
    <!-- SVG, img, or canvas -->
    <img src="puzzle-001.svg" alt="City road network">
  </div>

  <!-- options go here -->
</div>
```

The `data-prompt` attribute renders a small label at the bottom of the image automatically via CSS.

---

### Option Buttons (2-column grid)

```html
<div class="bs-options">
  <button class="bs-opt" data-correct="true" onclick="handleGuess(this)">
    <span class="bs-opt-inner">
      <span class="bs-opt-dot"></span>
      Phoenix, AZ
    </span>
    <span class="bs-opt-arrow">→</span>
  </button>

  <button class="bs-opt" onclick="handleGuess(this)">
    <span class="bs-opt-inner">
      <span class="bs-opt-dot"></span>
      Tucson, AZ
    </span>
    <span class="bs-opt-arrow">→</span>
  </button>
  <!-- repeat for all options -->
</div>
```

For a single-column list (Editorial-style), use `.bs-options-stack` instead of `.bs-options`.

**Answer state classes** — add to `.bs-opt` after guess:

| Class | Meaning |
|---|---|
| `.correct` | Player chose this and it's right |
| `.wrong` | Player chose this and it's wrong |
| `.reveal` | Correct answer, shown after wrong guess |

---

### Guess Handler (JavaScript pattern)

```javascript
function handleGuess(btn) {
  const allBtns = document.querySelectorAll('.bs-opt');
  const isCorrect = btn.dataset.correct === 'true';

  // Disable all
  allBtns.forEach(b => b.disabled = true);

  // Style the chosen button
  btn.classList.add(isCorrect ? 'correct' : 'wrong');
  btn.classList.add(isCorrect ? 'bs-anim-pop' : 'bs-anim-shake');

  // Reveal correct answer if wrong
  if (!isCorrect) {
    allBtns.forEach(b => {
      if (b.dataset.correct === 'true') b.classList.add('reveal');
    });
  }

  // Show result panel
  setTimeout(() => {
    document.getElementById('result').classList.add('show', 'bs-anim-fade-up');
  }, 360);
}
```

---

### Result Panel

Hidden by default. Add `.show` to reveal after a guess.

```html
<div class="bs-result" id="result">

  <!-- Gradient hero strip -->
  <div class="bs-result-hero">
    <div>
      <div class="bs-result-verdict">Correct!</div>
      <div class="bs-result-sub">Phoenix, AZ — you got it.</div>
    </div>
    <div class="bs-result-emoji">✅</div>
  </div>

  <!-- Stats row -->
  <div class="bs-stats">
    <div class="bs-stat">
      <div class="bs-stat-num">47</div>
      <div class="bs-stat-lbl">Played</div>
    </div>
    <div class="bs-stat">
      <div class="bs-stat-num">74%</div>
      <div class="bs-stat-lbl">Win %</div>
    </div>
    <div class="bs-stat">
      <div class="bs-stat-num">8</div>
      <div class="bs-stat-lbl">Streak</div>
    </div>
    <div class="bs-stat">
      <div class="bs-stat-num">14</div>
      <div class="bs-stat-lbl">Best</div>
    </div>
  </div>

  <!-- Fun fact -->
  <div class="bs-fact">
    <div class="bs-fact-icon">🗺️</div>
    <div>
      <div class="bs-fact-label">Did you know</div>
      <div class="bs-fact-text">Phoenix follows strict 1-mile township survey blocks...</div>
    </div>
  </div>

  <!-- Share string preview -->
  <div class="bs-share-preview">
    Road Grid #47 ✅<br>
    Streak: 8 🗺️<br>
    roadgrid.app
  </div>

  <!-- Actions -->
  <div class="bs-actions">
    <button class="bs-btn bs-btn-primary" onclick="copyShare()">📋 Copy &amp; Share</button>
    <button class="bs-btn bs-btn-secondary" onclick="resetGame()">Reset</button>
  </div>

</div>
```

---

### Analytics Grid (Realignment / Fitness)

```html
<div class="bs-analytics-grid">
  <div class="bs-analytic">
    <div class="bs-analytic-label">✈ Avg Travel</div>
    <div class="bs-analytic-value">847 mi</div>
    <div class="bs-analytic-delta down">▼ 12% from baseline</div>
  </div>
  <div class="bs-analytic">
    <div class="bs-analytic-label">🤝 Rivalries</div>
    <div class="bs-analytic-value">51%</div>
    <div class="bs-analytic-delta up">▲ 3 preserved</div>
    <div class="bs-analytic-sub">34 of 67 pairs</div>
  </div>
</div>
```

Delta classes: `.up` (green), `.down` (red), `.flat` (muted).

---

### Stadium Cards

```html
<div class="bs-card-grid">
  <div class="bs-stadium-card visited" onclick="this.classList.toggle('visited')">
    <div class="bs-stadium-team">Alabama</div>
    <div class="bs-stadium-name">Bryant-Denny Stadium</div>
    <div class="bs-stadium-meta">
      <span class="bs-stadium-conf">SEC</span>
      <span class="bs-stadium-check">✓</span>
    </div>
  </div>
  <!-- repeat -->
</div>
```

Toggle `.visited` on click to mark a stadium as attended.

---

### Team Pills (Realignment drag-drop)

```html
<div class="bs-conf-header">
  <div class="bs-conf-name">SEC</div>
  <div class="bs-conf-count">16 teams</div>
</div>

<div class="bs-pills">
  <div class="bs-pill" draggable="true">Alabama</div>
  <div class="bs-pill" draggable="true">Georgia</div>
  <div class="bs-pill" draggable="true">Tennessee</div>
</div>
```

---

### Upload Drop Zones (Fitness)

```html
<div class="bs-upload-zones">
  <div class="bs-upload-zone loaded">
    <div class="bs-upload-icon">🟠</div>
    <div class="bs-upload-name">Strava</div>
    <div class="bs-upload-sub">847 activities</div>
  </div>
  <div class="bs-upload-zone">
    <div class="bs-upload-icon">🍎</div>
    <div class="bs-upload-name">Apple</div>
    <div class="bs-upload-sub">Drop ZIP</div>
  </div>
  <div class="bs-upload-zone">
    <div class="bs-upload-icon">🔵</div>
    <div class="bs-upload-name">Garmin</div>
    <div class="bs-upload-sub">Drop ZIP</div>
  </div>
</div>
```

Add `.loaded` when a file has been successfully parsed.

---

### Privacy Notice (Fitness)

```html
<div class="bs-privacy">
  <strong>Your data never leaves your device.</strong>
  All processing happens in your browser — nothing is uploaded to any server.
</div>
```

---

### Toast Notification

Add once at the bottom of `<body>`. Toggle `.show` via JS.

```html
<div id="bs-toast">Copied! ✓</div>
```

```javascript
function showToast(message = 'Copied! ✓') {
  const toast = document.getElementById('bs-toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}
```

---

## Animation Classes

Add to any element via JavaScript after an event.

| Class | Effect | Use case |
|---|---|---|
| `.bs-anim-pop` | Scale in + fade | Correct answer, badge unlock |
| `.bs-anim-shake` | Horizontal shake | Wrong answer |
| `.bs-anim-fade-up` | Fade + rise from below | Result panel reveal |
| `.bs-anim-fade-in` | Simple fade | Secondary reveals |

---

## CSS Variable Reference

```css
/* Override in :root or on a specific element */

/* Colors */
--grad-a          /* Gradient start — darkest, top-left */
--grad-b          /* Gradient end — lightest, bottom-right */
--accent          /* Interactive color: hover, labels, borders */
--accent-light    /* Tint: hover backgrounds, badge fills */

/* Surfaces */
--bg              /* Page / card background */
--surface         /* Slightly off-white: option buttons, analytic tiles */
--surface-2       /* Deeper surface: rarely used */
--border          /* Standard border */
--border-mid      /* Mid-weight border: focused states */

/* Text */
--text            /* Primary — headings, values */
--text-mid        /* Secondary — body copy */
--text-muted      /* Tertiary — labels, meta */

/* States */
--correct         /* Green — correct answer, visited */
--correct-bg      /* Green tint background */
--correct-bd      /* Green border */
--wrong           /* Red — incorrect answer */
--wrong-bg        /* Red tint background */
--wrong-bd        /* Red border */
--warn            /* Amber — warning states */
--warn-bg         /* Amber tint background */

/* Spacing (4px base scale) */
--sp-1 through --sp-10

/* Radius */
--radius-sm       /* 6px */
--radius-md       /* 10px */
--radius-lg       /* 16px — card corners */

/* Shadow */
--shadow-card     /* Full card drop shadow */
--shadow-sm       /* Subtle element shadow */
```

---

## Typography

Two fonts. No exceptions.

| Role | Font | Weight | Class |
|---|---|---|---|
| App name, verdict, score, conference name | Barlow Condensed | 700–800 | `.bs-display-*` |
| Everything else | Inter | 400–700 | `.bs-body`, `.bs-label` |

```css
--font-display: 'Barlow Condensed', sans-serif;
--font-body:    'Inter', sans-serif;
```

---

## File Structure

```
design-system/
  theme.css       ← the shared system (this file)
  README.md       ← this documentation

ui-sampler/
  v3/index.html   ← live demo of all 5 app themes

conference-realignment/   ← app 1
stadium-bucket-list/      ← app 2
road-grid-guesser/        ← app 3
highway-trivia/           ← app 4
fitness-visualizer/       ← app 5
```

Each app links to `../design-system/theme.css` and applies its app class. No other shared dependencies.

---

## Adding a New App

1. Add a new app class to `theme.css` under "App Themes":
   ```css
   .app-my-app {
     --grad-a:        #hexcolor;
     --grad-b:        #hexcolor;
     --accent:        #hexcolor;
     --accent-light:  #hexcolor;
   }
   ```

2. Start your HTML with:
   ```html
   <link rel="stylesheet" href="../design-system/theme.css">
   ...
   <div class="bs-card app-my-app">
   ```

3. Use `.bs-*` components as needed.

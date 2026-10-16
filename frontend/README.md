# Jasjot Sir Spacer Land Platform — Frontend

Interactive real-estate colony layout and plot management UI built with **Vite**, **React 19**, and **TailwindCSS**.

## Project Architecture

```
frontend/
└── src/
    ├── app/          # App entry and Routing configuration
    ├── components/   # UI & Feature components (map, property, ownership, admin, owner)
    ├── pages/        # Page views (auth, admin, owner, public)
    ├── layouts/      # App layout wrappers (AdminLayout, OwnerLayout)
    ├── hooks/        # Custom React hooks
    ├── lib/          # Helper utilities, API clients, and geometry handlers
    ├── constants/    # Central constants and test IDs
    └── styles/       # Global styling & custom map themes
```

## Available Scripts

In the project directory, you can run:

### `npm run dev`
Runs the application in development mode with HMR.
Open [http://localhost:5173](http://localhost:5173) to view it in your browser.

### `npm run build`
Builds the app for production to the `dist` folder.

### `npm run preview`
Locally preview the production build.

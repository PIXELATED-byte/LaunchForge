// ==========================================
// LAUNCHFORGE — MAIN JAVASCRIPT
// ==========================================

// ---------- DOM ELEMENTS ----------

const projectDialog = document.querySelector("#project-dialog");
const projectForm = document.querySelector("#project-form");

const newProjectButton = document.querySelector("#new-project-button");
const startBuildingButton = document.querySelector("#start-building-button");
const closeDialogButton = document.querySelector("#close-dialog-button");

const projectsContainer = document.querySelector("#projects-container");
const projectCount = document.querySelector("#project-count");

const projectWorkspace = document.querySelector("#project-workspace");
const backToDashboardButton = document.querySelector("#back-to-dashboard");

const workspaceTitle = document.querySelector("#workspace-title");
const workspaceType = document.querySelector("#workspace-type");
const workspaceDescription = document.querySelector("#workspace-description");

const generateWebsiteButton = document.querySelector("#generate-website");
const websiteStatus = document.querySelector("#website-status");
const websitePreview = document.querySelector("#website-preview");
const websitePreviewContainer = document.querySelector(
    "#website-preview-container"
);

const upgradeButton = document.querySelector("#upgrade-button");

// ---------- PROJECT DATA ----------

let selectedProject = null;
let projects = [];

try {
    projects = JSON.parse(
        localStorage.getItem("launchforge-projects") || "[]"
    );

    if (!Array.isArray(projects)) {
        projects = [];
    }
} catch (error) {
    console.error("Could not load saved projects:", error);
    projects = [];
}

// ---------- SAVE PROJECTS ----------

function saveProjects() {
    try {
        localStorage.setItem(
            "launchforge-projects",
            JSON.stringify(projects)
        );
    } catch (error) {
        console.error("Could not save projects:", error);
        alert("Your projects could not be saved in this browser.");
    }
}

// ---------- OPEN PROJECT ----------

function openProject(project) {
    selectedProject = project;

    workspaceTitle.textContent = project.businessName;
    workspaceType.textContent = project.businessType;
    workspaceDescription.textContent = project.description;

    projectsContainer.classList.add("hidden");
    projectWorkspace.classList.remove("hidden");

    if (project.generatedWebsite) {
        websitePreview.srcdoc = project.generatedWebsite;

        websitePreviewContainer.classList.remove("hidden");

        websiteStatus.textContent =
            "Your website has been generated.";

        generateWebsiteButton.textContent =
            "↻ Regenerate Website";
    } else {
        websitePreview.srcdoc = "";

        websitePreviewContainer.classList.add("hidden");

        websiteStatus.textContent =
            "Your website hasn't been generated yet.";

        generateWebsiteButton.textContent =
            "✨ Generate Website";
    }
}

// ---------- PROJECT DIALOG ----------

function openProjectDialog() {
    projectDialog.showModal();
}

function closeProjectDialog() {
    projectDialog.close();
}

newProjectButton.addEventListener("click", openProjectDialog);
startBuildingButton.addEventListener("click", openProjectDialog);
closeDialogButton.addEventListener("click", closeProjectDialog);

// ---------- RENDER PROJECTS ----------

function renderProjects() {
    projectCount.textContent =
        `${projects.length} ${
            projects.length === 1 ? "project" : "projects"
        }`;

    projectsContainer.replaceChildren();

    if (projects.length === 0) {
        const emptyState = document.createElement("div");
        emptyState.className = "empty-state";

        const heading = document.createElement("h3");
        heading.textContent = "Your workspace is ready.";

        const message = document.createElement("p");
        message.textContent =
            "Create your first project to get started.";

        emptyState.append(heading, message);
        projectsContainer.append(emptyState);

        return;
    }

    projects.forEach((project) => {
        const card = document.createElement("article");

        card.className = "project-card";
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute(
            "aria-label",
            `Open ${project.businessName}`
        );

        card.addEventListener("click", () => {
            openProject(project);
        });

        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openProject(project);
            }
        });

        const type = document.createElement("p");
        type.className = "project-type";
        type.textContent = project.businessType;

        const heading = document.createElement("h3");
        heading.textContent = project.businessName;

        const description = document.createElement("p");
        description.className = "project-description";
        description.textContent = project.description;

        const status = document.createElement("p");
        status.textContent = project.generatedWebsite
            ? "Website generated"
            : "Project created · Website not generated yet";

        card.append(type, heading, description, status);
        projectsContainer.append(card);
    });
}

// ---------- CREATE A PROJECT ----------

projectForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(projectForm);

    const project = {
        businessName: String(
            formData.get("businessName") || ""
        ).trim(),

        businessType: String(
            formData.get("businessType") || "Other"
        ),

        description: String(
            formData.get("description") || ""
        )
            .trim()
            .replace(/\bcusine\b/gi, "cuisine"),

        generatedWebsite: ""
    };

    if (!project.businessName) {
        alert("Please enter a business name.");
        return;
    }

    projects.push(project);

    saveProjects();
    renderProjects();

    projectForm.reset();
    closeProjectDialog();
});

// ---------- BACK TO DASHBOARD ----------

backToDashboardButton.addEventListener("click", () => {
    projectWorkspace.classList.add("hidden");
    projectsContainer.classList.remove("hidden");

    selectedProject = null;
});

// ---------- ESCAPE HTML ----------

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return entities[character];
    });
}

// ---------- GENERATE WEBSITE HTML ----------

function generateWebsiteHTML(project) {
    const name = escapeHTML(project.businessName);
    const description = escapeHTML(project.description);
    const type = String(project.businessType).toLowerCase();

    let heading = `Welcome to ${name}`;
    let buttonText = "Get in Touch";
    let sectionTitle = "What We Do";
    let sectionText = description;

    let background = "#f5f0e8";
    let accent = "#795548";

    if (type.includes("restaurant") || type.includes("food")) {
        heading = "Good Food. Great Memories.";
        buttonText = "Explore Our Menu";
        sectionTitle = "A Taste Worth Remembering";

        background = "#fff8ed";
        accent = "#9c3d26";
    } else if (
        type.includes("portfolio") ||
        type.includes("freelanc")
    ) {
        heading = "Ideas Into Results.";
        buttonText = "Let's Work Together";
        sectionTitle = "How I Can Help";

        background = "#f4f4f5";
        accent = "#4338ca";
    } else if (
        type.includes("agency") ||
        type.includes("business")
    ) {
        heading = "Build Something Exceptional.";
        buttonText = "Start a Conversation";
        sectionTitle = "Our Approach";

        background = "#f0f4ff";
        accent = "#1d4ed8";
    } else if (
        type.includes("shop") ||
        type.includes("ecommerce")
    ) {
        heading = "Discover Your Next Favourite.";
        buttonText = "Explore Collection";
        sectionTitle = "Made for You";

        background = "#f8f0f6";
        accent = "#93336e";
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <!-- FIX: Keep relative links inside the generated srcdoc page. -->
    <base href="about:srcdoc">

    <title>${name}</title>

    <style>
        * {
            box-sizing: border-box;
        }

        html {
            scroll-behavior: smooth;
        }

        body {
            margin: 0;
            font-family: Arial, Helvetica, sans-serif;
            color: #202020;
            background: ${background};
        }

        nav {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 20px;
            padding: 24px 7%;
            background: white;
        }

        .brand {
            font-size: 20px;
            font-weight: 800;
        }

        nav a {
            color: ${accent};
            text-decoration: none;
            font-weight: 700;
        }

        nav a:hover {
            text-decoration: underline;
        }

        .hero {
            padding: 100px 8%;
            text-align: center;
        }

        .eyebrow {
            color: ${accent};
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 3px;
            text-transform: uppercase;
        }

        h1 {
            max-width: 850px;
            margin: 20px auto;
            font-size: clamp(38px, 7vw, 76px);
            line-height: 1.05;
            letter-spacing: -2px;
        }

        .intro {
            max-width: 600px;
            margin: 20px auto 30px;
            color: #606060;
            font-size: 17px;
            line-height: 1.8;
        }

        .cta {
            display: inline-block;
            padding: 15px 24px;
            border-radius: 6px;
            background: ${accent};
            color: white;
            text-decoration: none;
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            transition: opacity 0.2s ease;
        }

        .cta:hover {
            opacity: 0.85;
        }

        .about {
            padding: 70px 8%;
            background: white;
            text-align: center;
            scroll-margin-top: 20px;
        }

        .about h2,
        .contact h2 {
            font-size: 32px;
        }

        .about p,
        .contact p {
            max-width: 650px;
            margin: 20px auto;
            color: #606060;
            line-height: 1.8;
        }

        .contact {
            padding: 70px 8%;
            background: ${background};
            text-align: center;
            scroll-margin-top: 20px;
        }

        footer {
            padding: 25px;
            text-align: center;
            background: white;
            color: #777;
            font-size: 13px;
        }

        @media (max-width: 600px) {
            nav {
                padding: 20px;
            }

            .hero {
                padding: 75px 22px;
            }

            .about,
            .contact {
                padding: 55px 22px;
            }
        }
    </style>
</head>

<body>
    <nav>
        <div class="brand">${name}</div>
        <a
    href="#about"
    onclick="event.preventDefault(); document.getElementById('about').scrollIntoView({behavior:'smooth'});"
>
    About
</a>
    </nav>

    <main>
        <section class="hero">
            <p class="eyebrow">${escapeHTML(project.businessType)}</p>

            <h1>${heading}</h1>

            <p class="intro">${description}</p>

            <a
    class="cta"
    href="#contact"
    onclick="event.preventDefault(); document.getElementById('contact').scrollIntoView({behavior:'smooth'});"
>
    ${buttonText}
</a>
        </section>

        <section class="about" id="about">
            <p class="eyebrow">GET TO KNOW US</p>
            <h2>${sectionTitle}</h2>
            <p>${sectionText}</p>
        </section>

        <section class="contact" id="contact">
            <p class="eyebrow">LET'S CONNECT</p>
            <h2>Get in Touch</h2>

            <p>
                Interested in learning more about ${name}?
                We'd love to hear from you.
            </p>
        </section>
    </main>

    <footer>
        &copy; ${new Date().getFullYear()} ${name}.
        All rights reserved.
    </footer>
</body>
</html>`;
}

// ---------- GENERATE WEBSITE BUTTON ----------

generateWebsiteButton.addEventListener("click", () => {
    if (!selectedProject) {
        return;
    }

    generateWebsiteButton.disabled = true;
    generateWebsiteButton.textContent = "Generating...";

    try {
        const websiteHTML = generateWebsiteHTML(selectedProject);

        selectedProject.generatedWebsite = websiteHTML;

        saveProjects();
        renderProjects();

        websitePreview.srcdoc = websiteHTML;

        websitePreviewContainer.classList.remove("hidden");

        websiteStatus.textContent =
            "Website generated successfully! Preview it below.";

        generateWebsiteButton.textContent =
            "↻ Regenerate Website";
    } catch (error) {
        console.error("Website generation failed:", error);

        websiteStatus.textContent =
            "Something went wrong. Please try again.";

        generateWebsiteButton.textContent =
            "✨ Generate Website";
    } finally {
        generateWebsiteButton.disabled = false;
    }
});

// ---------- SUBSCRIPTION BUTTON ----------

if (upgradeButton) {
    upgradeButton.addEventListener("click", () => {
        alert("Subscription plans are coming later.");
    });
}

// ---------- INITIALIZE LAUNCHFORGE ----------

renderProjects();
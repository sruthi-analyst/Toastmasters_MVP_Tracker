document.addEventListener("DOMContentLoaded", () => {
    loadPodium();
});

async function loadPodium() {

    const today = new Date();

    const month =
        today.getFullYear() +
        "-" +
        String(today.getMonth() + 1).padStart(2, "0");

    try {

        const response = await fetch(`/api/podium/${month}`);

        if (!response.ok)
            throw new Error("Unable to fetch podium");

        const podium = await response.json();

        renderPodium(podium);

    }
    catch (err) {

        console.error(err);

        document.getElementById("podiumLoading").innerHTML =
            "<span>Unable to load podium.</span>";

    }

}
function renderPodium(data) {

    const loading = document.getElementById("podiumLoading");
    const stage = document.getElementById("podiumStage");

    loading.style.display = "none";
    stage.style.display = "flex";

    if (!data || data.length === 0) {

        stage.innerHTML = `
            <div class="podium-empty">
                No meeting data available for this month.
            </div>
        `;
        return;
    }

    // Display Silver - Gold - Bronze
    const displayOrder = [];

    if (data[1]) displayOrder.push({ ...data[1], rank: 2 });
    if (data[0]) displayOrder.push({ ...data[0], rank: 1 });
    if (data[2]) displayOrder.push({ ...data[2], rank: 3 });

    const medals = {
        1: "🥇",
        2: "🥈",
        3: "🥉"
    };

    stage.innerHTML = displayOrder.map(member => {

        const initials =
            member.name
                .split(" ")
                .map(x => x[0])
                .join("")
                .substring(0, 2)
                .toUpperCase();

        return `

        <div class="podium-card" data-rank="${member.rank}">

            <div class="podium-photo-container">
                <div class="podium-photo">
                    ${member.avatar 
                        ? `<img src="${member.avatar}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`
                        : `<svg class="photo-placeholder" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                               <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                           </svg>`
                    }
                </div>
            </div>

            <div class="podium-avatar-wrapper">
                <div class="podium-avatar">
                    ${initials}
                </div>
                <span class="podium-medal">
                    ${medals[member.rank]}
                </span>
            </div>

            <div class="podium-name">
                ${member.name}
            </div>

            <div class="podium-points">
                ${member.points} pts
            </div>

            <div class="podium-block">
                ${member.rank}
            </div>

        </div>

        `;

    }).join("");

}
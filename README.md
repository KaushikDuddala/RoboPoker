Inspiration
We thought it would be cool to see if a robot could actually play poker in real life and not just in a simulation. Poker is all about strategy, probability, and reading the game, so we wanted to combine robotics and AI and see if we could build something that physically sits at the table and competes.

What it does
RoboPoker is a robot that can play poker with real cards on a real table.

It uses cameras to see the board and track what’s happening, processes the game state, decides what move to make, and then physically makes that move using a robotic arm. As of right now it can speak to all the players, do specific movements we assign, read and analyze cards, and can hold cards with its claw.

How we built it
We 3D printed custom parts for the robotic arm and used some robotic components we already had. We designed everything to fit together, adjusted it, rebuilt parts when they didn’t work, and kept refining it until it moved smoothly.

Most of the real work was in the programming: We built a computer vision system to recognize cards and track the board, created a poker engine that understands the rules and keeps track of the game, programmed decision-making logic based on probability and strategy, connected everything so the robot can see, think, and move in one continuous system, as well as getting the hardware and software to actually talk to each other consistently was the hardest and most important part.

Challenges we ran into
Card detection wasn’t always accurate because of lighting and camera angles, the robotic arm needed a lot of calibration to move precisely, syncing real-world gameplay with the online player system was tricky, and small mechanical errors would mess up the whole flow.

Accomplishments that we're proud of
Building a robot that actually plays live poker, not just a simulation. Also managed to successfully combine vision, AI decision-making, and physical movement. Got to design and print our own mechanical parts, and got the full system working end-to-end.

What we learned
We learned that hardware and software integration is harder than either one alone. Also, lighting and physical setup matter a lot for computer vision, and strategy in games like poker is deeply mathematical.

What's next for RoboPoker
Right now, players log in online, but the cards are dealt in person. Next, we want to add something that lets the robot pick up and place chips by itself. We also want to remove the online login part so everything is fully in person. That means real cards, real chips, and no online system at all. We also plan to make the AI smarter so it can make better decisions over time. The goal is to have a robot that can sit at a table and play poker just like a normal person.

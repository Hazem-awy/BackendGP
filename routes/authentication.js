const router = require("express").Router();
const conn = require("../db/dbConnection");
const { body, validationResult } = require("express-validator");
const util = require("util");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const express = require("express");
const saltRounds = 10; // Number of salt rounds for bcrypt


//---------------------------------------START OF AUTHENTICATION----------------------------------------------------

router.post(
  "/student-login",
  body("student_id")
    .isInt()
    .withMessage("Please enter a valid student ID (integer)"),
  body("password")
    .isLength({ min: 8, max: 12 })
    .withMessage("Password should be between (8-12) characters"),
  async (req, res) => {
    try {
      // 1- VALIDATION REQUEST [manual, express validation]
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // 2- CHECK IF STUDENT ID EXISTS
      const query = util.promisify(conn.query).bind(conn);
      const student = await query("select * from students where student_id = ?", [
        req.body.student_id,
      ]);
      if (student.length === 0) {
        res.status(404).json({
          errors: [
            {
              msg: "Student ID or password not found!",
            },
          ],
        });
        return; // Exit the function early to prevent further processing
      }

      // 3- COMPARE HASHED PASSWORD
      const checkPassword = await bcrypt.compare(
        req.body.password,
        student[0].student_password
      );
      if (checkPassword) {
        delete student[0].student_password; // Exclude password from response
        const newToken = crypto.randomBytes(16).toString("hex");
        student[0].student_token = newToken;

        // Update student token in database (optional)
        // await query('UPDATE students SET student_token = ? WHERE student_id = ?', [newToken, student[0].student_id]);

        res.status(200).json(student[0]);
      } else {
        res.status(404).json({
          errors: [
            {
              msg: "Student ID or password not found!",
            },
          ],
        });
      }
    } catch (err) {
      console.error("Error logging in student:", err);
      res.status(500).json({ err: "Server error" });
    }
  }
);


router.post(
  "/student-register",
  body("email")
    .isEmail()
    .withMessage("Please enter a valid email!")
    .custom((value) => {
      if (!value.endsWith("@fci.helwan.edu.eg")) {
        throw new Error("Email domain must be '@fci.helwan.edu.eg'");
      }
      return true;
    }),
  body("student_name")
    .isString()
    .withMessage("Please enter a valid name")
    .isLength({ min: 10, max: 20 })
    .withMessage("Name should be between (10-20) characters"),
  body("password")
    .isLength({ min: 8, max: 12 })
    .withMessage("Password should be between (8-12) characters"),
  async (req, res) => {
    try {
      // 1- VALIDATION REQUEST [manual, express validation]
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // 2- CHECK FOR DUPLICATE STUDENT ID
      const checkStudentIdExists = await conn.query(
        "select * from students where student_id = ?",
        [req.body.student_id]
      );
      if (checkStudentIdExists.length > 0) {
        return res.status(409).json({
          error: "Student ID already exists!",
        });
      }

      // 3- CHECK FOR DUPLICATE EMAIL
      const checkEmailExists = await conn.query(
        "select * from students where student_email = ?",
        [req.body.email]
      );
      if (checkEmailExists.length > 0) {
        return res.status(409).json({
          error: "Email already exists!",
        });
      }

      // 4- PREPARE STUDENT OBJECT TO -> SAVE
      const studentData = {
        student_id: req.body.student_id,
        student_name: req.body.student_name,
        student_email: req.body.email,
        student_password: await bcrypt.hash(req.body.password, 10),
        student_department: req.body.student_department,
        student_project_id: null,
        student_token: crypto.randomBytes(16).toString("hex"),
      };

      // 5- INSERT STUDENT OBJECT INTO DB
      await conn.query("insert into students set ? ", studentData);
      delete studentData.student_password;
      res.status(201).json(studentData);
    } catch (err) {
      console.error("Error registering student:", err);
      res.status(500).json({ err: "Server error" });
    }
  }
);

//------------------------------------END OF AUTHENTICATION--------------------------------------------------------


//-----------------------------------START OF PROJECTS PAGE--------------------------------------------------------

// Set up multer storage ------------Handels The Poject Images-----------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "project_files/"); // Specify the folder where uploaded RAR files will be stored
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)); // Generate a unique filename
  },
});

// Initialize multer instance
const upload = multer({ storage: storage });


// Create a new project
router.post("/register-project", upload.single("projectFile"), async (req, res) => {
  const {
    title,
    description,
    supervisor_name,
    graduation_year,
    graduation_term,
    department_name,
    github_link,
    teammateData, // Ensure this is part of your request body
  } = req.body;

  // Check if file is uploaded correctly
  const project_file_path = req.file ? req.file.path : null;

  try {
    // Check if any of the student IDs already exist in project_students table
    const studentIds = teammateData.map(teammate => teammate.studentId);
    const existingStudents = await checkExistingStudents(studentIds);
    if (existingStudents.length > 0) {
      return res.status(400).json({ error: "One or more students are already associated with a project" });
    }

    // Start a transaction
    await startTransaction();

    // Insert the project into the projects table
    const projectInsertion = await insertProject(
      title,
      description,
      supervisor_name,
      graduation_year,
      graduation_term,
      department_name,
      project_file_path,
      github_link
    );

    const projectId = projectInsertion.insertId;

    // For each teammate, insert a record into the project_students table
    if (teammateData && teammateData.length) {
      for (const teammate of teammateData) {
        await insertProjectStudent(projectId, teammate.name, teammate.studentId);
      }
    }

    // If everything was successful, commit the transaction
    await commitTransaction();

    // Send success response
    res.status(201).json({ message: "Project and student associations created successfully" });

  } catch (err) {
    console.error("Error in project creation or student association:", err);

    // Attempt to rollback the transaction on error
    await rollbackTransaction();

    // Delete uploaded file if it exists and an error occurred
    if (project_file_path) {
      fs.unlink(project_file_path, (unlinkErr) => {
        if (unlinkErr) {
          console.error("Error deleting uploaded file:", unlinkErr);
        }
      });
    }

    // Send an error response to the client
    res.status(500).json({ error: "Server error during project creation. Transaction has been rolled back." });
  }
});

// Function to check if any of the provided student IDs already exist in project_students table
function checkExistingStudents(studentIds) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT student_id FROM project_students WHERE student_id IN (?)";
    conn.query(sql, [studentIds], (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}


// Function to start a transaction
function startTransaction() {
  return new Promise((resolve, reject) => {
    conn.beginTransaction((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Function to commit a transaction
function commitTransaction() {
  return new Promise((resolve, reject) => {
    conn.commit((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Function to rollback a transaction
function rollbackTransaction() {
  return new Promise((resolve, reject) => {
    conn.rollback((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Function to insert a project into the projects table
function insertProject(title, description, supervisor_name, graduation_year, graduation_term, department_name, project_files_path, github_link) {
  return new Promise((resolve, reject) => {
    const sql = "INSERT INTO projects (title, description, supervisor_name, graduation_year, graduation_term, department_name, project_files_path, github_link, approval_status, total_votes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)";
    conn.query(sql, [title, description, supervisor_name, graduation_year, graduation_term, department_name, project_files_path, github_link], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Function to insert a project student into the project_students table
function insertProjectStudent(projectId, studentName, studentId) {
  return new Promise((resolve, reject) => {
    const sql = "INSERT INTO project_students (project_id, student_name, student_id) VALUES (?, ?, ?)";
    conn.query(sql, [projectId, studentName, studentId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
// Get a list of all projects
router.get('/projects', (req, res) => {
  // Fetch all projects from database with selected fields
  conn.query('SELECT project_id, title, description, supervisor_name, graduation_year, graduation_term, department_name, project_image_path, github_link, approval_status, total_votes FROM Projects', (err, results) => {
    if (err) {
      res.status(500).json({ error: 'Error fetching projects' });
    } else {
      res.status(200).json(results);
    }
  });
});

// Get details of a specific project by ID
router.get('/projects/:id', (req, res) => {
  const projectId = req.params.id;
  // Fetch project from database by ID with selected fields
  conn.query('SELECT project_id, title, description, supervisor_name, graduation_year, graduation_term, department_name, project_image_path, github_link, IFNULL(approval_status, "pending") AS approval_status, IFNULL(total_votes, 0) AS total_votes FROM Projects WHERE project_id = ?', [projectId], (err, results) => {
    if (err) {
      res.status(500).json({ error: 'Error fetching project' });
    } else if (results.length === 0) {
      res.status(404).json({ error: 'Project not found' });
    } else {
      res.status(200).json(results[0]);
    }
  });
});

// Update an existing project by ID
router.put('/projects/:id', (req, res) => {
  const projectId = req.params.id;
  const { title, description, supervisor_name, graduation_year, graduation_term, department_name, project_image_path, github_link } = req.body;
  // Update project in database by ID
  conn.query('UPDATE Projects SET title = ?, description = ?, supervisor_name = ?, graduation_year = ?, graduation_term = ?, department_name = ?, project_image_path = ?, github_link = ? WHERE project_id = ?', [title, description, supervisor_name, graduation_year, graduation_term, department_name, project_image_path, github_link, projectId], (err, result) => {
    if (err) {
      res.status(500).json({ error: 'Error updating project' });
    } else {
      res.status(200).json({ message: 'Project updated successfully' });
    }
  });
});

// Delete a project by ID
router.delete('/projects/:id', (req, res) => {
  const projectId = req.params.id;
  // Delete project from database by ID
  conn.query('DELETE FROM Projects WHERE project_id = ?', [projectId], (err, result) => {
    if (err) {
      res.status(500).json({ error: 'Error deleting project' });
    } else {
      res.status(200).json({ message: 'Project deleted successfully' });
    }
  });
});
//-------------------------------------------------END OF PROJECTS PAGE-------------------------------------------------------


//--------------------------------------------Comments Page----------------------------
// POST request to add a comment
router.post('/add-comment/:project_id', async (req, res) => {
  const { commenter_id, comment_text } = req.body;
  const project_id = req.params.project_id;

  try {
    // Insert the comment into the database
    const result = await insertComment(project_id, commenter_id, comment_text);

    // Send success response
    res.status(201).json({ message: 'Comment added successfully', comment_id: result.insertId });
  } catch (err) {
    console.error('Error adding comment:', err);
    res.status(500).json({ error: 'Server error while adding comment' });
  }
});

// Function to insert a comment into the Comments table
function insertComment(project_id, commenter_id, comment_text) {
  return new Promise((resolve, reject) => {
    // Query to fetch the commenter's name from the students table
    const query = 'SELECT student_name FROM students WHERE student_id = ?';

    conn.query(query, [commenter_id], (err, results) => {
      if (err) {
        reject(err);
      } else {
        const commenter_name = results[0] ? results[0].student_name : null;

        // Insert the comment with the commenter's name
        const sql = 'INSERT INTO comments (project_id, commenter_id, commenter_name, comment_text) VALUES (?, ?, ?, ?)';
        const values = [project_id, commenter_id, commenter_name, comment_text];

        conn.query(sql, values, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      }
    });
  });
}

// GET request to SHOW all comments by project_id

router.get("/show-comments/:project_id", async (req, res) => {
  const { project_id } = req.params;

  try {
    // Query to fetch all comments for the specified project ID
    const sql = 'SELECT * FROM comments WHERE project_id = ?';
    
    conn.query(sql, [project_id], (err, results) => {
      if (err) {
        console.error("Error fetching comments:", err);
        res.status(500).json({ error: "Server error" });
      } else {
        // Send the comments as the response
        res.status(200).json({ comments: results });
      }
    });
  } catch (err) {
    console.error("Error fetching comments:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET request to delete a comment by comment_id

router.delete("/delete-comment/:comment_id", async (req, res) => {
  const { comment_id } = req.params;

  try {
    // Query to delete the comment with the specified comment ID
    const sql = 'DELETE FROM comments WHERE comment_id = ?';
    
    conn.query(sql, [comment_id], (err, result) => {
      if (err) {
        console.error("Error deleting comment:", err);
        res.status(500).json({ error: "Server error" });
      } else {
        // Check if any comment was deleted
        if (result.affectedRows > 0) {
          res.status(200).json({ message: "Comment deleted successfully" });
        } else {
          res.status(404).json({ error: "Comment not found" });
        }
      }
    });
  } catch (err) {
    console.error("Error deleting comment:", err);
    res.status(500).json({ error: "Server error" });
  }
});
//---------------------------------------End of comments page--------------------------


//-----------------------------------start of Bookmark page-----------------------------

// add a bookmark for a project
router.post("/add-bookmark/:project_id/:student_id", async (req, res) => {
  const { student_id, project_id } = req.params; // Extract student_id and project_id from URL parameters

  try {
    // Retrieve project details to include in the bookmark
    const projectDetails = await getProjectDetails(project_id);

    // Check if the project exists
    if (!projectDetails) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Check if the student has already bookmarked this project
    const bookmarkExists = await checkBookmarkExists(student_id, project_id);
    if (bookmarkExists) {
      return res.status(400).json({ error: "Bookmark already added for this project" });
    }

    const { title, department_name, total_votes } = projectDetails;

    // Insert bookmark into Bookmarks table
    await insertBookmark(student_id, project_id, title, department_name, total_votes);

    // Send success response
    res.status(201).json({ message: "Bookmark added successfully" });
  } catch (error) {
    console.error("Error adding bookmark:", error);
    res.status(500).json({ error: "Failed to add bookmark" });
  }
});

// Function to get project details
function getProjectDetails(project_id) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT title, department_name, total_votes FROM Projects WHERE project_id = ?";
    conn.query(sql, [project_id], (err, result) => {
      if (err) {
        reject(err);
      } else if (result.length === 0) {
        resolve(null); // Project not found
      } else {
        resolve(result[0]); // Return project details
      }
    });
  });
}

// Function to check if the student has already bookmarked the project
function checkBookmarkExists(student_id, project_id) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT COUNT(*) AS count FROM Bookmarks WHERE student_id = ? AND project_id = ?";
    conn.query(sql, [student_id, project_id], (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result[0].count > 0);
      }
    });
  });
}

// Function to insert a bookmark into the Bookmarks table
function insertBookmark(student_id, project_id, title, department_name, total_votes) {
  return new Promise((resolve, reject) => {
    const sql = "INSERT INTO Bookmarks (student_id, project_id, title, department_name, total_votes) VALUES (?, ?, ?, ?, ?)";
    conn.query(sql, [student_id, project_id, title, department_name, total_votes], (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Get all the bookmarks associated with this student_id
router.get("/show-bookmarks/:student_id", async (req, res) => {
  const studentId = req.params.student_id;

  try {
    // Query to retrieve all bookmarks associated with the student ID
    const sql = `
      SELECT bookmarks.bookmark_id, projects.title, projects.department_name, projects.total_votes
      FROM bookmarks
      INNER JOIN projects ON bookmarks.project_id = projects.project_id
      WHERE bookmarks.student_id = ?
    `;
    conn.query(sql, [studentId], (err, result) => {
      if (err) {
        console.error("Error retrieving bookmarks:", err);
        res.status(500).json({ error: "Server error" });
      } else {
        res.status(200).json(result);
      }
    });
  } catch (err) {
    console.error("Error retrieving bookmarks:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete a bookmark by a bookmark_id
router.delete("/delete-bookmarks/:bookmark_id", async (req, res) => {
  const bookmarkId = req.params.bookmark_id;

  try {
    // Query to delete the bookmark
    const sql = "DELETE FROM bookmarks WHERE bookmark_id = ?";
    conn.query(sql, [bookmarkId], (err, result) => {
      if (err) {
        console.error("Error deleting bookmark:", err);
        res.status(500).json({ error: "Server error" });
      } else {
        if (result.affectedRows > 0) {
          res.status(200).json({ message: "Bookmark deleted successfully" });
        } else {
          res.status(404).json({ error: "Bookmark not found" });
        }
      }
    });
  } catch (err) {
    console.error("Error deleting bookmark:", err);
    res.status(500).json({ error: "Server error" });
  }
});

//-----------------------------------END of Bookmark page-----------------------------



//---------------------------------Start of the admin page---------------------------------------

// Get a list of pending projects
router.get('/pending-projects', (req, res) => {
  // Fetch pending projects from the database
  conn.query('SELECT * FROM Projects WHERE approval_status = "pending"', (err, results) => {
    if (err) {
      res.status(500).json({ error: 'Error fetching pending projects' });
    } else {
      res.status(200).json(results);
    }
  });
});

// Get a list of accepted projects
router.get('/accepted-projects', (req, res) => {
  conn.query('SELECT * FROM Projects WHERE approval_status = "accepted"', (err, results) => {
    if (err) {
      res.status(500).json({ error: 'Error fetching accepted projects' });
    } else {
      res.status(200).json(results);
    }
  });
});

// Get a list of rejected projects
router.get('/rejected-projects', (req, res) => {
  conn.query('SELECT * FROM Projects WHERE approval_status = "rejected"', (err, results) => {
    if (err) {
      res.status(500).json({ error: 'Error fetching rejected projects' });
    } else {
      res.status(200).json(results);
    }
  });
});

// Function to insert a new professor into the Professors table
function insertProfessor(name, email, password, department, token) {
  return new Promise((resolve, reject) => {
    const sql = 'INSERT INTO professor (professor_name, professor_email, professor_password, professor_department, professor_token) VALUES (?, ?, ?, ?, ?)';
    conn.query(sql, [name, email, password, department, token], (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

// Create a new professor
router.post("/create-professor", async (req, res) => {
  const { name, email, password, department } = req.body;

  try {
    // Generate a random token for the professor
    const token = crypto.randomBytes(16).toString("hex");

    // Hash the password
    const hashedPassword = await hashPassword(password);

    // Insert the professor into the database
    await insertProfessor(name, email, hashedPassword, department, token);

    // Send success response
    res.status(201).json({ message: "Professor created successfully", token });
  } catch (error) {
    console.error("Error creating professor:", error);
    res.status(500).json({ error: "Server error while creating professor" });
  }
});

// Function to hash a password
async function hashPassword(password) {
  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    return hashedPassword;
  } catch (error) {
    throw error;
  }
}

// Delete a comment by comment_id
router.delete('/comments/:comment_id', (req, res) => {
  const commentId = req.params.comment_id;

  conn.query('DELETE FROM Comments WHERE comment_id = ?', [commentId], (err, result) => {
    if (err) {
      res.status(500).json({ error: 'Error deleting comment' });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: 'Comment deleted successfully' });
      } else {
        res.status(404).json({ error: 'Comment not found' });
      }
    }
  });
});

// Delete a student account by student_id
router.delete('/delete-student/:student_id', (req, res) => {
  const studentId = req.params.student_id;

  conn.query('DELETE FROM Students WHERE student_id = ?', [studentId], (err, result) => {
    if (err) {
      res.status(500).json({ error: 'Error deleting student account' });
    } else {
      if (result.affectedRows > 0) {
        res.status(200).json({ message: 'Student account deleted successfully' });
      } else {
        res.status(404).json({ error: 'Student account not found' });
      }
    }
  });
});

//-----------------------------------END of admin page-----------------------------



// lol
module.exports = router;
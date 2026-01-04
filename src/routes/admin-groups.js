/**
 * Admin Model Groups Routes
 * Handles virtual model alias management
 */

import { Router } from "express";
import {
  createModelGroup,
  listModelGroups,
  getModelGroupById,
  deleteModelGroupById,
  addModelToGroup,
  removeModelFromGroup,
} from "../services/database.js";
import { adminAuthMiddleware } from "./admin-auth.js";

const router = Router();

// Apply auth middleware to all routes
router.use(adminAuthMiddleware);

// List all model groups for current user
router.get("/", (req, res) => {
  try {
    const groups = listModelGroups(req.user.id);
    res.json(groups);
  } catch (error) {
    console.error("List groups error:", error);
    res.status(500).json({ error: "Failed to list model groups" });
  }
});

// Create new model group
router.post("/", (req, res) => {
  try {
    const { alias, strategy } = req.body;

    if (!alias) {
      return res.status(400).json({ error: "Alias is required" });
    }

    const validStrategies = ["priority", "random"];
    const groupStrategy = validStrategies.includes(strategy)
      ? strategy
      : "priority";

    const result = createModelGroup(req.user.id, alias, groupStrategy);

    res.json({
      success: true,
      id: result.lastInsertRowid,
      alias,
      strategy: groupStrategy,
    });
  } catch (error) {
    console.error("Create group error:", error);
    if (error.message?.includes("UNIQUE constraint")) {
      return res.status(400).json({ error: "Group alias already exists" });
    }
    res.status(500).json({ error: "Failed to create model group" });
  }
});

// Delete model group
router.delete("/:id", (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const group = getModelGroupById(groupId);

    if (!group || group.user_id !== req.user.id) {
      return res.status(404).json({ error: "Model group not found" });
    }

    deleteModelGroupById(groupId);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete group error:", error);
    res.status(500).json({ error: "Failed to delete model group" });
  }
});

// Add model to group
router.post("/:id/models", (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { model_name, order_index } = req.body;

    if (!model_name) {
      return res.status(400).json({ error: "Model name is required" });
    }

    const group = getModelGroupById(groupId);
    if (!group || group.user_id !== req.user.id) {
      return res.status(404).json({ error: "Model group not found" });
    }

    const result = addModelToGroup(groupId, model_name, order_index || 0);

    res.json({
      success: true,
      id: result.lastInsertRowid,
    });
  } catch (error) {
    console.error("Add model error:", error);
    res.status(500).json({ error: "Failed to add model to group" });
  }
});

// Remove model from group
router.delete("/:id/models/:modelName", (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const modelName = decodeURIComponent(req.params.modelName);

    const group = getModelGroupById(groupId);
    if (!group || group.user_id !== req.user.id) {
      return res.status(404).json({ error: "Model group not found" });
    }

    removeModelFromGroup(groupId, modelName);
    res.json({ success: true });
  } catch (error) {
    console.error("Remove model error:", error);
    res.status(500).json({ error: "Failed to remove model from group" });
  }
});

export default router;

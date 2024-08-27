from django.db import models

class Message(models.Model):
    text = models.CharField(max_length=100)
    public = models.BooleanField()
